// End-to-end tests. No network: Gemini is faked, the upstream API is a local HTTP server.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { build } from "../dist/build.js";
import { main } from "../dist/cli.js";
import { draft, load } from "../dist/curate.js";
import { deployCommand } from "../dist/deploy.js";
import { propose } from "../dist/gemini.js";
import { callTool, folderFactory, listTools, rawFactory } from "../dist/measure.js";
import { loadSpec, operations, suggestName } from "../dist/spec.js";

const EX = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
const SHOP = join(EX, "shop-openapi.yaml");
const CUR = join(EX, "shop-mcp.yaml");
const tmp = () => mkdtempSync(join(tmpdir(), "mcpsmith-"));

test("audit flags the usual suspects and suggests names", () => {
  const ops = Object.fromEntries(operations(loadSpec(SHOP)).map((o) => [o.operationId, o]));
  assert.ok(ops.delete_customer.risky);
  assert.ok(ops.admin_reindex_search.risky);
  assert.ok(!ops.post_refunds.risky);
  assert.ok(ops.list_orders_v2__get.findings.some((f) => f.includes("cryptic")));
  assert.equal(suggestName(ops.list_orders_v2__get), "list_orders");
  assert.equal(suggestName(ops.post_refunds), "create_refund");
  assert.equal(suggestName(ops.get_refund_status), "get_refund_status");
});

test("heuristic draft excludes risky ops and hides pagination", () => {
  const { text } = draft(loadSpec(SHOP), { specName: "shop.yaml" });
  const cfg = YAML.parse(text);
  assert.equal(cfg.tools.delete_customer.include, false);
  assert.deepEqual(cfg.tools.list_orders_v2__get.args.lim, { hide: true, default: 20 });
});

const FAKE_GEMINI = {
  stories: ["As an agent, given a customer's email, I find their orders and refund one."],
  tools: [
    { operation_id: "list_orders_v2__get", name: "find_orders", description: "Find a customer's orders by email. Use before refunding.", reason: "refund story",
      args: [{ param: "q", rename: "customer_email", description: "Customer email" }, { param: "lim", hide: true, default: "10" }, { param: "nope", hide: true }] },
    { operation_id: "post_refunds", name: "create_refund", description: "Refund a paid order, fully or partly.", reason: "refund story",
      args: [{ param: "order_id", hide: true }] },
    { operation_id: "delete_customer", name: "delete_customer", description: "x", reason: "cleanup" },
    { operation_id: "made_up", name: "made_up", description: "x", reason: "x" },
    { operation_id: "get_refund_status", name: "Bad Name!", description: "Check a refund.", reason: "x" },
  ],
};

test("Gemini's proposal is validated before it reaches mcp.yaml", async () => {
  const spec = loadSpec(SHOP);
  const ops = operations(spec);
  let prompt = "";
  const r = await propose("Shop", ops, ["refund story"], "m", async (p) => { prompt = p; return JSON.stringify(FAKE_GEMINI); });
  assert.ok(prompt.includes("refund story") && prompt.includes("list_orders_v2__get"));
  assert.deepEqual(r.overrides.list_orders_v2__get.args, { q: { rename: "customer_email", description: "Customer email" }, lim: { hide: true, default: 10 } });
  assert.ok(!("order_id" in r.overrides.post_refunds.args));   // required, no default → stays visible
  assert.equal(r.overrides.delete_customer.include, false);     // risky never switched on
  assert.ok(!("made_up" in r.overrides));
  assert.equal(r.overrides.get_refund_status.name, undefined);  // invalid name dropped
  assert.equal(r.warnings.length, 5);
  const { text } = draft(spec, { specName: "shop.yaml", ops, overrides: r.overrides, stories: r.stories, model: "m" });
  const cfg = YAML.parse(text);
  assert.equal(cfg.tools.list_orders_v2__get.name, "find_orders");
  assert.equal(cfg.tools.get_order_v2__get.include, false);   // not proposed → excluded
  assert.ok(text.includes("gemini wanted this"));
  assert.doesNotThrow(() => load(writeTo(text), spec));       // round-trips through validation
});

function writeTo(text) { const p = join(tmp(), "mcp.yaml"); writeFileSync(p, text); return p; }

test("validation catches unknown params, duplicate names and bad auth", () => {
  const spec = loadSpec(SHOP);
  const bad = readFileSync(CUR, "utf8").replace("name: get_order\n", "name: find_orders\n")
    .replace("lim: {hide: true, default: 20}", "lim: {hide: true, default: 20}\n      bogus: {hide: true}")
    .replace("token_path: responseBody.accessToken", "");
  assert.throws(() => load(writeTo(bad), spec), (e) => /bogus/.test(e.message) && /already used/.test(e.message) && /token_path/.test(e.message));
});

function fakeApi() {
  const seen = [];
  const good = "Basic " + Buffer.from("key:secret").toString("base64");
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/api/v1/auth/login") return req.headers.authorization === good
      ? send(200, { responseBody: { accessToken: "tok", expiresIn: 3600 } }) : send(401, {});
    if (req.headers.authorization !== "Bearer tok") return send(401, { error: "no token" });
    if (req.method === "GET" && req.url.startsWith("/v2/orders")) return send(200, [{ id: "o1", url: req.url }]);
    if (req.method === "POST" && req.url === "/v2/refunds") return send(201, { id: "r1", received: JSON.parse(body) });
    send(404, {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test("generated server calls the API with login auth, renamed and hidden args", async () => {
  const api = await fakeApi();
  const dir = tmp();
  const spec = loadSpec(SHOP);
  build(spec, load(CUR, spec), dir, "shop-openapi.yaml", "shop-mcp.yaml");
  Object.assign(process.env, { API_BASE_URL: api.url, API_KEY: "key", API_SECRET: "secret" });
  try {
    const names = (await listTools(await folderFactory(dir))).map((t) => t.name).sort();
    assert.deepEqual(names, ["create_refund", "find_orders", "get_order", "get_refund_status"]);
    const factory = await folderFactory(dir);
    const res = await callTool(factory, "find_orders", { customer_email: "a@b.co" });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.match(res.content[0].text, /q=a%40b\.co/);
    assert.match(res.content[0].text, /lim=20/);
    const refund = await callTool(factory, "create_refund", { order_id: "o1", reason: "wrong size" });
    assert.ok(!refund.isError, JSON.stringify(refund));
    assert.deepEqual(JSON.parse(refund.content[0].text).received, { order_id: "o1", reason: "wrong size" });
    const bad = await callTool(factory, "find_orders", { customer_email: "x", nope: 1 });
    assert.ok(bad.isError); // additionalProperties: false
    process.env.API_SECRET = "wrong";
    const denied = await callTool(await folderFactory(dir), "find_orders", { customer_email: "x" });
    assert.ok(denied.isError && /Login .* failed: HTTP 401/.test(denied.content[0].text));
  } finally { api.server.close(); delete process.env.API_BASE_URL; delete process.env.API_KEY; delete process.env.API_SECRET; }
});

test("raw conversion of the shop spec exposes every operation", async () => {
  const raw = await listTools(await rawFactory(loadSpec(SHOP)));
  assert.equal(raw.length, 7);
});

test("deploy is private with Secret Manager secrets", () => {
  const dir = tmp();
  const spec = loadSpec(SHOP);
  build(spec, load(CUR, spec), dir, "s.yaml", "m.yaml");
  const cmd = deployCommand(dir, "shop-mcp", "europe-west1", "proj", false, {});
  const joined = cmd.join(" ");
  assert.ok(cmd.includes("--no-allow-unauthenticated") && !cmd.includes("--allow-unauthenticated"));
  assert.ok(joined.includes("API_KEY=shop-mcp-api-key:latest") && joined.includes("API_SECRET=shop-mcp-api-secret:latest"));
  assert.ok(joined.includes("--project proj"));
});

test("connect writes Gemini CLI settings without clobbering others", async () => {
  const dir = tmp();
  const spec = loadSpec(SHOP);
  build(spec, load(CUR, spec), join(dir, "srv"), "s.yaml", "m.yaml");
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ theme: "dark", mcpServers: { other: { httpUrl: "x" } } }));
  const log = console.log; console.log = () => {};
  try {
    assert.equal(await main(["connect", join(dir, "srv"), "--settings", settings]), 0);
    let data = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(data.theme, "dark"); assert.ok(data.mcpServers.other);
    const e = data.mcpServers["demo-shop-api-mcp"];
    assert.equal(e.env.API_KEY, "$API_KEY"); assert.equal(e.env.MCP_TRANSPORT, "stdio"); assert.equal(e.trust, false);
    assert.equal(await main(["connect", join(dir, "srv"), "--settings", settings, "--url", "http://localhost:3000/mcp"]), 0);
    data = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(data.mcpServers["demo-shop-api-mcp"].httpUrl, "http://localhost:3000/mcp");
  } finally { console.log = log; }
});

test("form bodies use bracket notation; GET request bodies are ignored", async () => {
  const spec = {
    openapi: "3.0.0", info: { title: "Form", version: "1" }, servers: [{ url: "http://x" }],
    paths: {
      "/v1/refunds": { post: { operationId: "PostRefunds", summary: "Create a refund for a charge.",
        requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object",
          properties: { charge: { type: "string" }, metadata: { type: "object", additionalProperties: { type: "string" } },
            expand: { type: "array", items: { type: "string" } } } } } } }, responses: { 200: { description: "ok" } } } },
      "/v1/charges": { get: { operationId: "GetCharges", summary: "List all charges you created.",
        requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: {} } } } },
        responses: { 200: { description: "ok" } } } },
    },
  };
  let received = "", contentType = "";
  const server = createServer(async (req, res) => {
    for await (const c of req) received += c;
    contentType = req.headers["content-type"] ?? "";
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { runtime } = await import("../dist/runtime.js");
  const rt = await runtime();
  const factory = rt.createFactory({ spec, config: { baseUrl: `http://127.0.0.1:${server.address().port}`, auth: { type: "none" },
    tools: { PostRefunds: { name: "create_refund", args: {} }, GetCharges: { name: "list_charges", args: {} } } } });
  try {
    const tools = await listTools(factory);
    assert.deepEqual(Object.keys(tools.find((t) => t.name === "list_charges").inputSchema.properties), []);
    const res = await callTool(factory, "create_refund", { charge: "ch_1", metadata: { order: "o1" }, expand: ["charge"] });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(contentType, "application/x-www-form-urlencoded");
    assert.equal(decodeURIComponent(received), "charge=ch_1&metadata[order]=o1&expand[0]=charge");
  } finally { server.close(); }
});
