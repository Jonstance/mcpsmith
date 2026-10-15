// Load an OpenAPI 3.x spec and flatten it into operations with audit findings.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import YAML from "yaml";

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const RISKY_PATH = /(^|\/)(admin|internal|debug|_private|ops)(\/|$)/i;
const RISKY_TAGS = new Set(["admin", "internal", "private", "debug", "ops"]);
const VERSION_SEG = /^v\d+(\.\d+)*$/i;
export const PAGINATION_PARAMS = new Set(["page", "lim", "limit", "offset", "per_page", "perpage", "page_size",
  "pagesize", "size", "cursor", "skip", "take"]);
const NAME_SMELL = /(__|_v\d+|v\d+_|^(get|post|put|patch|delete)_(get|post|put|patch|delete)$)/;

export type Spec = Record<string, any>;

export interface Param {
  name: string;
  location: string; // path | query | header | cookie | body
  required: boolean;
  description: string;
  default?: unknown;
  type: string;
}

export interface Operation {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  params: Param[];
  findings: string[];
  risky: boolean;
  syntheticId: boolean;
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).join(" ");

export function opText(op: Operation): string {
  const s = stripHtml(op.summary), d = stripHtml(op.description);
  if (s && d && !d.toLowerCase().includes(s.replace(/\.$/, "").toLowerCase())) return `${s.replace(/\.$/, "")}. ${d}`;
  return d || s;
}

export function loadSpec(path: string): Spec {
  const raw = readFileSync(path, "utf8");
  const data = extname(path).toLowerCase() === ".json" ? JSON.parse(raw) : YAML.parse(raw, { maxAliasCount: -1 });
  if (!data || typeof data !== "object" || !("paths" in data)) throw new UserError(`${path}: not an OpenAPI document (no 'paths').`);
  const ver = String(data.openapi ?? data.swagger ?? "");
  if (!ver.startsWith("3")) {
    throw new UserError(`${path}: OpenAPI ${ver || "?"} found; mcpsmith needs OpenAPI 3.x (convert Swagger 2.0 first, e.g. with swagger2openapi).`);
  }
  return data;
}

export class UserError extends Error {}

export function resolve(spec: Spec, obj: any): any {
  let seen = 0;
  while (obj && typeof obj === "object" && typeof obj.$ref === "string" && seen < 20) {
    const ref: string = obj.$ref;
    if (!ref.startsWith("#/")) return obj;
    let node: any = spec;
    for (const part of ref.slice(2).split("/")) node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")] ?? {};
    obj = node;
    seen++;
  }
  return obj;
}

export function fallbackOpId(method: string, path: string): string {
  return `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`.toLowerCase();
}

export function withOperationIds(spec: Spec): Spec {
  const copy = structuredClone(spec);
  for (const [path, item] of Object.entries<any>(copy.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (op && typeof op === "object" && !op.operationId) op.operationId = fallbackOpId(m, path);
    }
  }
  return copy;
}

export function operations(spec: Spec): Operation[] {
  const ops: Operation[] = [];
  for (const [path, rawItem] of Object.entries<any>(spec.paths ?? {})) {
    const item = resolve(spec, rawItem) ?? {};
    const shared = (item.parameters ?? []).map((p: any) => resolve(spec, p));
    for (const method of HTTP_METHODS) {
      const raw = item[method];
      if (!raw) continue;
      const params = new Map<string, Param>();
      for (const p of [...shared, ...(raw.parameters ?? []).map((x: any) => resolve(spec, x))]) {
        if (!p || typeof p !== "object" || !p.name) continue;
        const schema = resolve(spec, p.schema ?? {}) ?? {};
        params.set(`${p.name}|${p.in ?? "query"}`, {
          name: p.name, location: p.in ?? "query", required: !!p.required,
          description: p.description || schema.description || "", default: schema.default, type: String(schema.type ?? ""),
        });
      }
      const body = resolve(spec, raw.requestBody ?? {}) ?? {};
      const content = body.content ?? {};
      const first = Object.values<any>(content)[0];
      if (first) {
        const schema = resolve(spec, first.schema ?? {}) ?? {};
        const req = new Set<string>(schema.required ?? []);
        for (const [name, propRaw] of Object.entries<any>(schema.properties ?? {})) {
          const prop = resolve(spec, propRaw) ?? {};
          if (!params.has(`${name}|body`)) {
            params.set(`${name}|body`, { name, location: "body", required: req.has(name), description: prop.description ?? "",
              default: prop.default, type: String(prop.type ?? "") });
          }
        }
      }
      const op: Operation = {
        operationId: raw.operationId || fallbackOpId(method, path),
        method: method.toUpperCase(), path,
        summary: String(raw.summary ?? "").trim(), description: String(raw.description ?? "").trim(),
        tags: [...(raw.tags ?? [])], deprecated: !!raw.deprecated, params: [...params.values()],
        findings: [], risky: false, syntheticId: !raw.operationId,
      };
      audit(op);
      ops.push(op);
    }
  }
  return ops;
}

function audit(op: Operation) {
  const f = op.findings;
  if (op.method === "DELETE") { f.push("destructive: DELETE — excluded by default"); op.risky = true; }
  if (RISKY_PATH.test(op.path) || op.tags.some((t) => RISKY_TAGS.has(t.toLowerCase()))) {
    f.push("looks internal/admin (path or tag) — excluded by default"); op.risky = true;
  }
  if (op.deprecated) { f.push("deprecated in spec — excluded by default"); op.risky = true; }
  const text = opText(op);
  if (!text) f.push("no summary or description — the model will have to guess from the name");
  else if (text.length < 25) f.push(`very short description (${text.length} chars) — say when to use it`);
  if (op.syntheticId) f.push("no operationId in spec — mcpsmith generated one; tool names are derived from the path");
  else if (NAME_SMELL.test(op.operationId) || !/^[A-Za-z0-9_]+$/.test(op.operationId)) {
    f.push(`operationId '${op.operationId}' is a poor tool name (version/__/symbols)`);
  }
  const cryptic = op.params.filter((p) => p.name.length <= 3 && p.name.toLowerCase() !== "id").map((p) => p.name);
  if (cryptic.length) f.push(`cryptic param names: ${cryptic.join(", ")} — rename them`);
  if (op.params.length > 8) f.push(`${op.params.length} params — consider hiding the ones agents never set`);
  const undocumented = op.params.filter((p) => !p.description && p.location !== "path");
  if (undocumented.length >= 3) f.push(`${undocumented.length} params have no description`);
}

export function singular(w: string): string {
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

export function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

export function suggestName(op: Operation): string {
  const oid = snake(op.operationId);
  if (!op.syntheticId && !NAME_SMELL.test(oid) && !/^(post|put|patch|head|options)_/.test(oid) && /^[a-z][a-z0-9_]{2,55}$/.test(oid)) {
    return oid;
  }
  const segs = op.path.split("/").filter(Boolean);
  const endsWithParam = segs.length > 0 && segs[segs.length - 1].startsWith("{");
  const nouns = segs.filter((s) => !s.startsWith("{") && !VERSION_SEG.test(s) && !["api", "rest"].includes(s.toLowerCase())).map(snake);
  if (!nouns.length) return oid.slice(0, 56);
  const resource = nouns[nouns.length - 1];
  const parent = nouns.length > 1 ? singular(nouns[nouns.length - 2]) : "";
  let verb: string, noun: string;
  switch (op.method) {
    case "GET": [verb, noun] = endsWithParam ? ["get", singular(resource)] : ["list", resource]; break;
    case "POST":
      if (nouns.length > 1 && !endsWithParam && segs.length > 1 && segs[segs.length - 2].startsWith("{")) {
        return `${resource}_${parent}`.slice(0, 56); // POST /things/{id}/cancel → cancel_thing
      }
      [verb, noun] = ["create", singular(resource)]; break;
    case "PUT": case "PATCH": [verb, noun] = ["update", singular(resource)]; break;
    case "DELETE": [verb, noun] = ["delete", singular(resource)]; break;
    default: [verb, noun] = [op.method.toLowerCase(), resource];
  }
  if (parent && parent !== noun && nouns.length > 1) noun = `${parent}_${noun}`;
  return `${verb}_${noun}`.slice(0, 56);
}
