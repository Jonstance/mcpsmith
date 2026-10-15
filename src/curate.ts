// Draft and load mcp.yaml: the human-reviewed layer between the spec and the server.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { Operation, PAGINATION_PARAMS, Spec, UserError, operations, opText, suggestName } from "./spec.js";

export const LARGE_SPEC = 30; // above this many safe operations, start from an empty allow-list
const NAME_RE = /^[A-Za-z0-9_-]{1,56}$/;

export interface ArgChange { rename?: string; description?: string; hide?: boolean; default?: unknown }
export interface ToolOverride {
  include: boolean; name?: string; description?: string; reason?: string;
  args: Record<string, ArgChange>; riskySuggested?: boolean;
}
export interface Auth { type: string; [k: string]: string }
export interface Curation {
  server: { name: string; baseUrl: string; timeoutMs: number };
  auth: Auth;
  tools: Record<string, { name: string; description?: string; args: Record<string, ArgChange> }>;
}

const q = (s: unknown) => JSON.stringify(s);
const yamlVal = (v: unknown) => JSON.stringify(v);

export function detectAuth(spec: Spec): string[] {
  const schemes = spec.components?.securitySchemes ?? {};
  for (const [name, s] of Object.entries<any>(schemes)) {
    const t = s.type, sch = String(s.scheme ?? "").toLowerCase();
    if (t === "http" && sch === "bearer") return ["type: bearer", "token_env: API_TOKEN"];
    if (t === "http" && sch === "basic") return ["type: basic", "username_env: API_USERNAME", "password_env: API_PASSWORD"];
    if (t === "apiKey" && s.in === "header") return ["type: api_key", `header: ${q(s.name ?? "X-API-Key")}`, "key_env: API_KEY"];
    if (t === "oauth2" || t === "openIdConnect") {
      return [`type: bearer   # spec declares ${t} ('${name}'); supply a token, or switch to login`, "token_env: API_TOKEN"];
    }
  }
  return ["type: none"];
}

export interface DraftOptions {
  specName: string; includeAll?: boolean; ops?: Operation[];
  overrides?: Record<string, ToolOverride>; stories?: string[]; model?: string;
}

export function draft(spec: Spec, o: DraftOptions): { text: string; ops: Operation[] } {
  const ops = o.ops ?? operations(spec);
  const safe = ops.filter((x) => !x.risky).length;
  const startEmpty = safe > LARGE_SPEC && !o.includeAll && !o.overrides;
  const info = spec.info ?? {};
  const base = spec.servers?.[0]?.url ?? "https://api.example.com";
  const out: string[] = [
    "# mcpsmith curation file — the reviewed layer between your spec and your MCP server.",
    `# Drafted from ${o.specName} (${info.title ?? "?"} ${info.version ?? ""}) on ${new Date().toISOString().slice(0, 10)}.`,
    "# Review every TODO, then: mcpsmith build <spec> <this file> -o <dir>",
    "#",
    "# Rules of thumb:",
    "#   include only what an agent story needs ('As an agent, given X, I use Y to achieve Z')",
    "#   name = verb_noun, no versions; description = what it does, when to use it, when NOT to",
    "#   hide params the model should never set (pagination, versions, internal flags)",
    "",
    "server:",
    `  name: ${q((info.title ?? "API") + " MCP")}`,
    `  base_url: ${q(base)}   # overridable at runtime with API_BASE_URL`,
    "  timeout: 30",
    "",
    "auth:   # none | bearer | api_key | basic | login",
    ...detectAuth(spec).map((l) => "  " + l),
    "  # Key + secret exchanged for a short-lived token (common for payment APIs):",
    "  # type: login",
    "  # login_url: /api/v1/auth/login        # relative to base_url, or absolute",
    "  # username_env: API_KEY                # sent as HTTP Basic to the login endpoint",
    "  # password_env: API_SECRET",
    "  # token_path: responseBody.accessToken  # dotted path into the login JSON",
    "  # expires_in_path: responseBody.expiresIn",
    "",
  ];
  if (o.overrides) {
    out.push(`# Curated with Gemini${o.model ? ` (${o.model})` : ""} for these agent stories:`,
      ...(o.stories ?? []).map((s) => `#   - ${s}`),
      "# Gemini proposed; you decide. Lines marked 'gemini:' are its reasoning.", "");
  }
  if (startEmpty) {
    out.push(`# LARGE SPEC: ${safe} safe operations is far more than an agent can use well, so every`,
      "# tool starts excluded. Write your agent stories, then set include: true on what they need.", "");
  }
  out.push("tools:");
  const used = new Map<string, number>();
  for (const op of ops) {
    const ov = o.overrides?.[op.operationId];
    let name = ov?.name || suggestName(op);
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name}_${n}`;
    const include = o.overrides ? !!ov?.include : !op.risky && !startEmpty;
    out.push(`  # ── ${op.method} ${op.path}` + (op.tags.length ? `  [${op.tags.join(", ")}]` : ""));
    for (const f of op.findings) out.push(`  # ! ${f}`);
    if (ov?.reason) out.push(`  # gemini: ${ov.reason.replace(/\s+/g, " ")}`);
    if (ov?.riskySuggested) out.push("  # gemini wanted this, but it is flagged risky: left excluded — your call");
    out.push(`  ${op.operationId}:`, `    include: ${include}`, `    name: ${name}`);
    const desc = ov?.description || opText(op) || "";
    const todo = desc.length >= 25 || !include ? "" : "   # TODO: what it does, when to use it, when not to";
    out.push(`    description: ${q(desc)}${todo}`);
    const argLines: string[] = [];
    if (ov) {
      for (const [p, a] of Object.entries(ov.args ?? {})) {
        argLines.push(`      ${p}: {` + Object.entries(a).map(([k, v]) => `${k}: ${yamlVal(v)}`).join(", ") + "}");
      }
    } else {
      for (const p of op.params) {
        if (PAGINATION_PARAMS.has(p.name.toLowerCase()) && !p.required) {
          const d = p.default !== undefined && p.default !== null ? `, default: ${yamlVal(p.default)}` : "";
          argLines.push(`      ${p.name}: {hide: true${d}}   # pagination — the model rarely needs it`);
        } else if (p.name.length <= 3 && p.name.toLowerCase() !== "id") {
          argLines.push(`      ${p.name}: {rename: ${p.name}, description: ${q(p.description)}}   # TODO: give it a self-explaining name`);
        }
      }
    }
    if (argLines.length) out.push("    args:", ...argLines);
    out.push("");
  }
  return { text: out.join("\n") + "\n", ops };
}

const AUTH_NEEDS: Record<string, string[]> = {
  bearer: ["token_env"], api_key: ["header", "key_env"], basic: ["username_env", "password_env"],
  login: ["login_url", "username_env", "password_env", "token_path"], none: [],
};

export function load(path: string, spec: Spec): Curation {
  let cfg: any;
  try { cfg = YAML.parse(readFileSync(path, "utf8")) ?? {}; } catch (e: any) { throw new UserError(`${path}: invalid YAML — ${e.message}`); }
  const ops = new Map(operations(spec).map((o) => [o.operationId, o]));
  const errors: string[] = [];
  const tools: Curation["tools"] = {};
  const seen = new Map<string, string>();
  for (const [oid, tRaw] of Object.entries<any>(cfg.tools ?? {})) {
    const t = tRaw ?? {};
    const op = ops.get(oid);
    if (!op) { errors.push(`tools.${oid}: no operation with that operationId in the spec`); continue; }
    if (!t.include) continue;
    const name = String(t.name || oid);
    if (!NAME_RE.test(name)) errors.push(`tools.${oid}.name '${name}': use 1–56 of A-Z a-z 0-9 _ -`);
    if (seen.has(name)) errors.push(`tools.${oid}.name '${name}': already used by ${seen.get(name)}`);
    seen.set(name, oid);
    const params = new Map(op.params.map((p) => [p.name, p]));
    const args: Record<string, ArgChange> = {};
    const newNames = new Set<string>();
    for (const [arg, aRaw] of Object.entries<any>(t.args ?? {})) {
      const a = aRaw ?? {};
      const p = params.get(arg);
      if (!p) { errors.push(`tools.${oid}.args.${arg}: not a parameter of this operation (has: ${[...params.keys()].join(", ") || "none"})`); continue; }
      if (a.hide && p.required && (a.default === undefined || a.default === null)) {
        errors.push(`tools.${oid}.args.${arg}: required — give a default to hide it`);
      }
      const nn = a.rename || arg;
      if (!a.hide) {
        if (newNames.has(nn)) errors.push(`tools.${oid}.args: two arguments renamed to '${nn}'`);
        newNames.add(nn);
      }
      const c: ArgChange = {};
      if (a.rename && a.rename !== arg) c.rename = String(a.rename);
      if (a.description) c.description = String(a.description);
      if (a.hide) c.hide = true;
      if (a.default !== undefined && a.default !== null) c.default = a.default;
      args[arg] = c;
    }
    tools[oid] = { name, ...(t.description ? { description: String(t.description).trim() } : {}), args };
  }
  if (!Object.keys(tools).length) errors.push("no tools have include: true");
  const auth: Auth = cfg.auth ?? { type: "none" };
  auth.type = auth.type ?? "none";
  const need = AUTH_NEEDS[auth.type];
  if (!need) errors.push(`auth.type '${auth.type}': use one of ${Object.keys(AUTH_NEEDS).join(", ")}`);
  else for (const k of need) if (!auth[k]) errors.push(`auth.${k}: required for type ${auth.type}`);
  if (errors.length) throw new UserError("Curation file has problems:\n  - " + errors.join("\n  - "));
  const srv = cfg.server ?? {};
  return {
    server: {
      name: String(srv.name ?? (spec.info?.title ?? "API") + " MCP"),
      baseUrl: String(srv.base_url ?? spec.servers?.[0]?.url ?? ""),
      timeoutMs: Math.round(Number(srv.timeout ?? 30) * 1000),
    },
    auth, tools,
  };
}
