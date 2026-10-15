// mcpsmith runtime: turns an OpenAPI spec + curation config into a working MCP server.
// Copied into every generated server (regenerated on each build), so a server never
// depends on the mcpsmith CLI. Needs @modelcontextprotocol/server and @modelcontextprotocol/node.
import { createServer } from "node:http";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const KEEP = new Set(["type", "properties", "required", "items", "enum", "const", "description", "default", "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "minItems",
  "maxItems", "uniqueItems", "additionalProperties", "anyOf", "oneOf", "title", "multipleOf"]);
const FORMATS = new Set(["date-time", "date", "time", "duration", "email", "idn-email", "hostname", "idn-hostname",
  "ipv4", "ipv6", "uri", "uri-reference", "iri", "iri-reference", "uuid", "uri-template", "json-pointer",
  "relative-json-pointer", "regex", "int32", "int64", "float", "double", "byte", "binary", "password"]);
const MAX_DEPTH = 6;
const MAX_RESULT_CHARS = 100_000;

// ---------------------------------------------------------------- schemas

function deref(spec, obj, seen) {
  while (obj && typeof obj === "object" && typeof obj.$ref === "string") {
    const ref = obj.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return { __cycle: true };
    seen = new Set(seen).add(ref);
    let node = spec;
    for (const part of ref.slice(2).split("/")) node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    obj = node ?? {};
  }
  return { obj, seen };
}

/** OpenAPI schema → plain JSON Schema an MCP client (and the validator) accepts. */
export function toJsonSchema(spec, schema, { depth = 0, seen = new Set(), writing = true } = {}) {
  const r = deref(spec, schema, seen);
  if (r.__cycle || depth > MAX_DEPTH) return {};
  let s = r.obj;
  if (!s || typeof s !== "object" || Array.isArray(s)) return {};
  if (Array.isArray(s.allOf)) {
    const merged = { ...s, allOf: undefined, properties: { ...(s.properties ?? {}) }, required: [...(s.required ?? [])] };
    for (const part of s.allOf) {
      const p = deref(spec, part, r.seen);
      if (p.__cycle || !p.obj) continue;
      Object.assign(merged.properties, p.obj.properties ?? {});
      merged.required.push(...(p.obj.required ?? []));
      if (!merged.type && p.obj.type) merged.type = p.obj.type;
      if (!merged.description && p.obj.description) merged.description = p.obj.description;
    }
    if (!Object.keys(merged.properties).length) delete merged.properties;
    if (!merged.required.length) delete merged.required;
    s = merged;
  }
  const out = {};
  const next = { depth: depth + 1, seen: r.seen, writing };
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k) || v === undefined) continue;
    if (k === "properties" && v && typeof v === "object") {
      const props = {};
      for (const [name, sub] of Object.entries(v)) {
        const d = deref(spec, sub, r.seen);
        if (!d.__cycle && writing && d.obj?.readOnly) continue; // server-generated fields aren't inputs
        props[name] = toJsonSchema(spec, sub, next);
      }
      out.properties = props;
    } else if (k === "items") out.items = toJsonSchema(spec, v, next);
    else if (k === "additionalProperties") out.additionalProperties = typeof v === "boolean" ? v : toJsonSchema(spec, v, next);
    else if (k === "anyOf" || k === "oneOf") out[k] = v.map((x) => toJsonSchema(spec, x, next));
    else if ((k === "exclusiveMinimum" || k === "exclusiveMaximum") && typeof v !== "number") continue; // 3.0 boolean form
    else if (k === "pattern") { try { new RegExp(v, "u"); out.pattern = v; } catch { /* not ECMA: drop */ } }
    else if (k === "format") { if (FORMATS.has(v)) out.format = v; } // vendor formats (e.g. "currency") make validators noisy
    else if (k === "required") { if (Array.isArray(v) && v.length) out.required = [...new Set(v)]; }
    else if (k === "type" && Array.isArray(v) && !v.length) continue;
    else out[k] = v;
  }
  if (out.required && out.properties) out.required = out.required.filter((n) => n in out.properties);
  if (out.required && !out.required.length) delete out.required;
  if (s.nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
  if (Array.isArray(s.examples) && s.examples.length) out.examples = s.examples.slice(0, 3);
  else if (s.example !== undefined) out.examples = [s.example];
  return out;
}

// ---------------------------------------------------------------- tools

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "tool";
}

export function fallbackOpId(method, path) {
  return `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`.toLowerCase();
}

function textOf(op) {
  const strip = (x) => String(x ?? "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).join(" ");
  const s = strip(op.summary), d = strip(op.description);
  if (s && d && !d.toLowerCase().includes(s.replace(/\.$/, "").toLowerCase())) return `${s.replace(/\.$/, "")}. ${d}`;
  return d || s;
}

/**
 * Build tool definitions.
 * config.tools: { [operationId]: { name, description?, args: { [param]: {rename?, description?, hide?, default?} } } }
 * Pass config.tools = null to expose every operation (what a raw conversion would do).
 */
export function buildTools(spec, config) {
  const selected = config.tools;
  const tools = [];
  const names = new Set();
  for (const [path, rawItem] of Object.entries(spec.paths ?? {})) {
    const item = deref(spec, rawItem, new Set()).obj ?? {};
    const shared = item.parameters ?? [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const opId = op.operationId || fallbackOpId(method, path);
      const cur = selected ? selected[opId] : {};
      if (!cur) continue;
      const args = []; // {arg, in, name, schema, required, style, explode}
      const byName = new Map();
      for (const pr of [...shared, ...(op.parameters ?? [])]) {
        const p = deref(spec, pr, new Set()).obj;
        if (!p?.name || !p.in) continue;
        if (p.in === "header" && /^(authorization|content-type|accept)$/i.test(p.name)) continue;
        byName.set(`${p.in}:${p.name}`, p);
      }
      for (const p of byName.values()) {
        const schema = toJsonSchema(spec, p.schema ?? {});
        if (p.description && !schema.description) schema.description = p.description;
        args.push({ arg: p.name, in: p.in, name: p.name, schema, required: p.in === "path" || !!p.required,
          style: p.style, explode: p.explode });
      }
      const rb = deref(spec, op.requestBody ?? {}, new Set()).obj ?? {};
      const noBody = method === "get" || method === "head"; // fetch can't send a body with these
      const [mediaType, media] = noBody ? [] : Object.entries(rb.content ?? {}).sort(([a], [b]) => rank(a) - rank(b))[0] ?? [];
      let bodyKind = null;
      if (media) {
        bodyKind = /json/i.test(mediaType) ? "json" : /x-www-form-urlencoded/i.test(mediaType) ? "form"
          : /multipart\/form-data/i.test(mediaType) ? "multipart" : "text";
        const schema = toJsonSchema(spec, media.schema ?? {});
        const taken = new Set(args.map((a) => a.arg));
        if (schema.type === "object" || schema.properties) {
          const req = new Set(schema.required ?? []);
          for (const [name, ps] of Object.entries(schema.properties ?? {})) {
            const arg = taken.has(name) ? `${name}_body` : name;
            args.push({ arg, in: "body", name, schema: ps, required: req.has(name) });
          }
          if (!Object.keys(schema.properties ?? {}).length && schema.additionalProperties) {
            args.push({ arg: "body", in: "body-whole", name: "body", schema, required: !!rb.required });
          }
        } else {
          args.push({ arg: taken.has("body") ? "request_body" : "body", in: "body-whole", name: "body", schema, required: !!rb.required });
        }
      }
      // apply curation
      const changes = cur.args ?? {};
      const hidden = [];
      const visible = [];
      for (const a of args) {
        const c = changes[a.name] ?? changes[a.arg] ?? {};
        if (c.hide) { if (c.default !== undefined && c.default !== null) hidden.push({ ...a, value: c.default }); continue; }
        const schema = { ...a.schema };
        if (c.description) schema.description = c.description;
        visible.push({ ...a, arg: c.rename || a.arg, schema });
      }
      const properties = {};
      const required = [];
      for (const a of visible) {
        properties[a.arg] = a.schema;
        if (a.required) required.push(a.arg);
      }
      let name = cur.name || slug(opId);
      if (names.has(name)) { let i = 2; while (names.has(`${name}_${i}`)) i++; name = `${name}_${i}`; }
      names.add(name);
      const m = method.toUpperCase();
      tools.push({
        name,
        description: (cur.description || textOf(op) || `${m} ${path}`).slice(0, 2000),
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
        annotations: { readOnlyHint: m === "GET" || m === "HEAD", destructiveHint: m === "DELETE",
          idempotentHint: ["GET", "HEAD", "PUT", "DELETE"].includes(m) },
        operationId: opId, method: m, path, bodyKind, args: visible, hidden,
      });
    }
  }
  return tools;
}

function rank(mediaType) {
  if (/json/i.test(mediaType)) return 0;
  if (/x-www-form-urlencoded/i.test(mediaType)) return 1;
  if (/multipart/i.test(mediaType)) return 2;
  return 3;
}

// ---------------------------------------------------------------- auth

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return v;
}

function dig(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function makeAuth(auth = { type: "none" }, baseUrl = "") {
  const basic = (u, p) => "Basic " + Buffer.from(`${env(u)}:${env(p)}`).toString("base64");
  switch (auth.type) {
    case "bearer": return { headers: async () => ({ Authorization: `Bearer ${env(auth.token_env)}` }) };
    case "api_key": return { headers: async () => ({ [auth.header]: env(auth.key_env) }) };
    case "basic": return { headers: async () => ({ Authorization: basic(auth.username_env, auth.password_env) }) };
    case "login": {
      let token = null, expiresAt = 0, pending = null;
      const url = /^https?:/.test(auth.login_url) ? auth.login_url : joinUrl(baseUrl, auth.login_url);
      const login = async () => {
        const res = await fetch(url, { method: auth.login_method || "POST",
          headers: { Authorization: basic(auth.username_env, auth.password_env), Accept: "application/json" },
          signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`Login to ${url} failed: HTTP ${res.status}`);
        const data = await res.json();
        token = dig(data, auth.token_path);
        if (!token) throw new Error(`Login response has no token at '${auth.token_path}'`);
        const ttl = auth.expires_in_path ? Number(dig(data, auth.expires_in_path)) : 3000;
        expiresAt = Date.now() + (Number.isFinite(ttl) ? ttl : 3000) * 1000;
      };
      const ensure = async (force) => {
        if (force || !token || Date.now() > expiresAt - 60_000) {
          pending ??= login().finally(() => { pending = null; });
          await pending;
        }
      };
      return {
        headers: async () => { await ensure(false); return { Authorization: `Bearer ${token}` }; },
        refresh: async () => { await ensure(true); return { Authorization: `Bearer ${token}` }; },
      };
    }
    default: return { headers: async () => ({}) };
  }
}

// ---------------------------------------------------------------- calls

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, "") + "/" + String(path).replace(/^\/+/, "");
}

function addQuery(qs, a, value) {
  const explode = a.explode ?? (a.style ? a.style === "form" : true);
  if (a.style === "deepObject" && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) qs.append(`${a.name}[${k}]`, typeof v === "object" ? JSON.stringify(v) : String(v));
  } else if (Array.isArray(value)) {
    if (explode) for (const v of value) qs.append(a.name, typeof v === "object" ? JSON.stringify(v) : String(v));
    else qs.append(a.name, value.map(String).join(a.style === "pipeDelimited" ? "|" : a.style === "spaceDelimited" ? " " : ","));
  } else if (value && typeof value === "object") qs.append(a.name, JSON.stringify(value));
  else qs.append(a.name, String(value));
}

/** Make the HTTP request for a tool call. Returns an MCP CallToolResult. */
export async function callTool(tool, input, ctx) {
  const values = [...tool.hidden.map((a) => [a, a.value]), ...tool.args.filter((a) => input[a.arg] !== undefined).map((a) => [a, input[a.arg]])];
  let path = tool.path;
  const qs = new URLSearchParams();
  const headers = { Accept: "application/json" };
  const body = {};
  let whole;
  for (const [a, v] of values) {
    if (v === null || v === undefined) continue;
    if (a.in === "path") path = path.replaceAll(`{${a.name}}`, encodeURIComponent(String(v)));
    else if (a.in === "query") addQuery(qs, a, v);
    else if (a.in === "header") headers[a.name] = String(v);
    else if (a.in === "cookie") headers.Cookie = [headers.Cookie, `${a.name}=${encodeURIComponent(String(v))}`].filter(Boolean).join("; ");
    else if (a.in === "body") body[a.name] = v;
    else if (a.in === "body-whole") whole = v;
  }
  let url = joinUrl(ctx.baseUrl, path);
  const query = qs.toString();
  if (query) url += (url.includes("?") ? "&" : "?") + query;
  let payload;
  const hasBody = whole !== undefined || Object.keys(body).length > 0;
  if (hasBody) {
    const data = whole !== undefined ? whole : body;
    if (tool.bodyKind === "form") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const qs = new URLSearchParams();
      const put = (key, v) => {
        if (v === null || v === undefined) return;
        if (Array.isArray(v)) v.forEach((x, i) => put(`${key}[${i}]`, x));
        else if (typeof v === "object") for (const [k, x] of Object.entries(v)) put(`${key}[${k}]`, x);
        else qs.append(key, String(v));
      };
      for (const [k, v] of Object.entries(data)) put(k, v); // nested values use bracket notation (a[b]=c, a[0]=d)
      payload = qs.toString();
    } else if (tool.bodyKind === "multipart") {
      payload = new FormData();
      for (const [k, v] of Object.entries(data)) payload.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    } else if (tool.bodyKind === "text") {
      headers["Content-Type"] = "text/plain";
      payload = typeof data === "string" ? data : JSON.stringify(data);
    } else {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(data);
    }
  }
  const send = async (authHeaders) => fetch(url, {
    method: tool.method, headers: { ...headers, ...authHeaders }, body: payload,
    signal: AbortSignal.timeout(ctx.timeoutMs ?? 30_000),
  });
  let res;
  try {
    res = await send(await ctx.auth.headers());
    if (res.status === 401 && ctx.auth.refresh) res = await send(await ctx.auth.refresh());
  } catch (e) {
    return { content: [{ type: "text", text: `Request to ${tool.method} ${tool.path} failed: ${e.message}` }], isError: true };
  }
  let text = await res.text();
  try { text = JSON.stringify(JSON.parse(text)); } catch { /* not JSON: keep as is */ }
  if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + `… [truncated ${text.length - MAX_RESULT_CHARS} chars]`;
  if (!res.ok) {
    return { content: [{ type: "text", text: `HTTP ${res.status} ${res.statusText} from ${tool.method} ${tool.path}: ${text.slice(0, 4000)}` }], isError: true };
  }
  return { content: [{ type: "text", text: text || `HTTP ${res.status}` }] };
}

// ---------------------------------------------------------------- server

/**
 * Returns a factory that builds a fresh McpServer (the stateless HTTP handler calls it per request).
 * options: { spec, config, register?(server, helpers), baseUrl? }
 */
export function createFactory({ spec, config, register }) {
  const tools = buildTools(spec, config);
  const baseUrl = process.env.API_BASE_URL || config.baseUrl;
  const auth = makeAuth(config.auth, baseUrl);
  const ctx = { baseUrl, auth, timeoutMs: config.timeoutMs };
  const request = async (method, path, { query, json, headers } = {}) => {
    let url = joinUrl(baseUrl, path);
    if (query) url += "?" + new URLSearchParams(query).toString();
    const send = async (h) => fetch(url, { method, headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers, ...h },
      body: json !== undefined ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(config.timeoutMs ?? 30_000) });
    let res = await send(await auth.headers());
    if (res.status === 401 && auth.refresh) res = await send(await auth.refresh());
    return res;
  };
  return function factory() {
    const server = new McpServer({ name: config.name ?? "mcpsmith server", version: config.version ?? "1.0.0" });
    for (const tool of tools) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema),
        annotations: tool.annotations,
      }, async (input) => callTool(tool, input ?? {}, ctx));
    }
    if (register) register(server, { request, baseUrl });
    return server;
  };
}

/** Serve over stdio (MCP_TRANSPORT=stdio) or Streamable HTTP (default) on PORT, path /mcp. */
export async function serve(options) {
  const factory = createFactory(options);
  if ((process.env.MCP_TRANSPORT ?? "http") === "stdio") {
    const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
    return serveStdio(factory);
  }
  const { toNodeHandler } = await import("@modelcontextprotocol/node");
  const handler = toNodeHandler(createMcpHandler(factory));
  const port = Number(process.env.PORT ?? 8000);
  const host = process.env.HOST ?? "0.0.0.0";
  const http = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/mcp" || path === "/mcp/") return void handler(req, res);
    if (path === "/healthz") { res.writeHead(200).end("ok"); return; }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("MCP endpoint is /mcp\n");
  });
  http.listen(port, host, () => console.error(`${options.config.name ?? "MCP server"}: http://${host}:${port}/mcp`));
  return http;
}
