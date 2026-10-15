#!/usr/bin/env node
// mcpsmith — OpenAPI spec → curated, shippable MCP server.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "./build.js";
import { draft, load } from "./curate.js";
import { connect, deploy } from "./deploy.js";
import { DEFAULT_MODEL, propose } from "./gemini.js";
import { approxTokens, callTool, folderFactory, listTools, rawFactory, ToolInfo } from "./measure.js";
import { Spec, UserError, loadSpec, operations } from "./spec.js";

const VERSION = "0.1.0";
const tty = process.stdout.isTTY;
const c = (code: string) => (s: string | number) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1"), dim = c("2"), red = c("31"), yel = c("33"), grn = c("32");
const h = (s: string) => console.log("\n" + bold(s));

const HELP = `mcpsmith ${VERSION} — OpenAPI spec → curated, shippable MCP server

  mcpsmith audit SPEC                   what a raw conversion exposes, and what's wrong with it
  mcpsmith init  SPEC [-o mcp.yaml]     draft the curation file for you to review
  mcpsmith build SPEC mcp.yaml -o DIR   generate the server (Node, Dockerfile, README)
  mcpsmith test  DIR [--spec SPEC]      list the tools a client sees; compare with the raw spec
  mcpsmith auto  SPEC -o DIR            audit + init + build in one go
  mcpsmith deploy DIR --region R        ship it to Cloud Run (private by default)
  mcpsmith connect DIR [--url URL]      add it to Gemini CLI

Gemini curation:  add --gemini [--stories stories.txt] [--model M] to init/auto (needs GEMINI_API_KEY)
Other flags:      --force  --include-all (init/auto)  --install (build/auto)  --no-test (build)
                  --call TOOL --args JSON (test)  --service --project --secret VAR=NAME --public --dry-run (deploy)
                  --scope project|user --name --settings PATH (connect)`;

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function cmdAudit(specPath: string) {
  const spec = loadSpec(specPath);
  const ops = operations(spec);
  if (ops.length > 100) console.log(dim(`Converting ${ops.length} operations to measure the raw tool list…`));
  const raw = await listTools(await rawFactory(spec));
  const risky = ops.filter((o) => o.risky), flagged = ops.filter((o) => o.findings.length);
  h(`Audit: ${spec.info?.title ?? specPath}`);
  console.log(`  Operations in spec        ${ops.length}`);
  console.log(`  Raw conversion exposes    ${raw.length} tools`);
  console.log(`  Tool list size (rough)    ~${approxTokens(raw).toLocaleString("en-US")} tokens on every model turn`);
  console.log(`  Risky operations          ${(risky.length ? red : grn)(risky.length)}  (DELETE, admin/internal, deprecated)`);
  console.log(`  Operations with findings  ${(flagged.length ? yel : grn)(flagged.length)}`);
  for (const o of flagged) {
    console.log(`\n  ${(o.risky ? red : yel)(o.method.padEnd(6))} ${o.path}  ${dim(o.operationId)}`);
    for (const f of o.findings) console.log(`         - ${f}`);
  }
  console.log("\n" + dim(`Next: mcpsmith init ${specPath}`));
}

function readStories(path?: string): string[] {
  if (!path) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim().replace(/^[-*\d.\s]+/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
}

async function makeDraft(spec: Spec, specPath: string, v: any) {
  const ops = operations(spec);
  const specName = basename(specPath);
  if (!v.gemini) {
    if (v.stories) console.log(yel("--stories is only used with --gemini; drafting with heuristics."));
    return draft(spec, { specName, includeAll: v["include-all"], ops });
  }
  const stories = readStories(v.stories);
  const model = v.model || DEFAULT_MODEL;
  console.log(`Asking Gemini (${model}) to curate ${ops.length} operations` +
    (stories.length ? ` for ${stories.length} agent stories…` : ", proposing agent stories first…"));
  const r = await propose(spec.info?.title ?? "API", ops, stories, model);
  for (const w of r.warnings) console.log(`  ${yel("!")} ${w}`);
  if (r.stories.length) { h("Agent stories"); for (const s of r.stories) console.log(`  - ${s}`); }
  return draft(spec, { specName, ops, overrides: r.overrides, stories: r.stories, model });
}

const includedCount = (text: string) => (text.match(/^ {4}include: true$/gm) ?? []).length;

async function cmdInit(specPath: string, v: any) {
  const spec = loadSpec(specPath);
  const out = v.output || "mcp.yaml";
  if (existsSync(out) && !v.force) throw new UserError(`${out} exists — it may hold your review. Use --force to overwrite.`);
  const { text, ops } = await makeDraft(spec, specPath, v);
  writeFileSync(out, text);
  const inc = includedCount(text);
  console.log(`Drafted ${out}: ${inc} of ${ops.length} operations included, ${ops.length - inc} excluded, ${(text.match(/# TODO/g) ?? []).length} TODOs to review.`);
  console.log(dim(`Next: review ${out}, then mcpsmith build ${specPath} ${out} -o mcp-server`));
}

function npmInstall(dir: string) {
  console.log(dim(`Installing the server's dependencies in ${dir}…`));
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: dir, stdio: "inherit" });
  if (r.status) console.log(yel(`npm install failed in ${dir}; run it yourself before starting the server.`));
}

async function report(dir: string, spec?: Spec) {
  let cur: ToolInfo[];
  try { cur = await listTools(await folderFactory(dir)); } catch (e: any) {
    if (e instanceof UserError) throw e;
    console.log(red("The generated server failed to load: ") + e.message);
    return 1;
  }
  h(`Tools an MCP client sees (${cur.length})`);
  const width = Math.max(10, ...cur.map((t) => t.name.length));
  for (const t of cur) {
    const props = Object.keys(t.inputSchema?.properties ?? {});
    const req = new Set<string>(t.inputSchema?.required ?? []);
    console.log(`  ${t.name.padEnd(width)}  (${props.map((p) => p + (req.has(p) ? "" : "?")).join(", ")})`);
    const desc = t.description.split(/\s+/).join(" ");
    console.log(`  ${"".padEnd(width)}  ${dim(short(desc || "(none)", 90))}${desc.length < 25 ? "  " + yel("← short description") : ""}`);
  }
  if (spec) {
    const raw = await listTools(await rawFactory(spec));
    h("Before → after");
    console.log(`  Tools              ${String(raw.length).padStart(5)} → ${cur.length}`);
    console.log(`  Tool list (rough)  ~${approxTokens(raw).toLocaleString("en-US")} → ~${approxTokens(cur).toLocaleString("en-US")} tokens per turn`);
  }
  return 0;
}

async function cmdBuild(specPath: string, curPath: string, v: any) {
  const spec = loadSpec(specPath);
  const cur = load(curPath, spec);
  const out = v.output || "mcp-server";
  const written = build(spec, cur, out, basename(specPath), basename(curPath));
  console.log(`Generated ${out}/: ${written.join(", ")}`);
  if (v.install) npmInstall(out);
  return v["no-test"] ? 0 : report(out, spec);
}

async function cmdTest(dir: string, v: any) {
  const rc = await report(dir, v.spec ? loadSpec(v.spec) : undefined);
  if (v.call) {
    const args = JSON.parse(v.args || "{}");
    h(`Calling ${v.call}(${JSON.stringify(args)}) against the real API`);
    const res = await callTool(await folderFactory(dir), v.call, args);
    console.log(`  ${res.isError ? red("error") : grn("ok")}:`);
    for (const b of res.content ?? []) console.log("    " + short(b.text ?? JSON.stringify(b), 1500));
    return res.isError ? 1 : rc;
  }
  return rc;
}

async function cmdAuto(specPath: string, v: any) {
  const spec = loadSpec(specPath);
  const out = v.output || "mcp-server";
  mkdirSync(out, { recursive: true });
  const curPath = join(out, "mcp.yaml");
  await cmdAudit(specPath);
  if (existsSync(curPath) && !v.force) console.log(`\nKeeping your existing ${curPath} (use --force to redraft).`);
  else {
    const { text } = await makeDraft(spec, specPath, v);
    writeFileSync(curPath, text);
    console.log(`\nDrafted ${curPath}`);
  }
  if (!includedCount(readFileSync(curPath, "utf8"))) {
    console.log("\n" + yel("Large spec: every tool starts excluded.") +
      ` Set include: true in ${curPath} for what your agent stories need (or rerun with --gemini), then: mcpsmith build ${specPath} ${curPath} -o ${out}`);
    return 0;
  }
  const cur = load(curPath, spec);
  const written = build(spec, cur, out, basename(specPath), "mcp.yaml");
  console.log(`Generated ${out}/: ${written.join(", ")}`);
  if (v.install) npmInstall(out);
  const rc = await report(out, spec);
  console.log(`\n${bold("Now curate:")} edit ${curPath} (TODOs, names, descriptions), then mcpsmith build ${specPath} ${curPath} -o ${out}`);
  return rc;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values: v, positionals: pos } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      output: { type: "string", short: "o" }, force: { type: "boolean" }, "include-all": { type: "boolean" },
      gemini: { type: "boolean" }, stories: { type: "string" }, model: { type: "string" },
      install: { type: "boolean" }, "no-test": { type: "boolean" },
      spec: { type: "string" }, call: { type: "string" }, args: { type: "string" },
      region: { type: "string" }, service: { type: "string" }, project: { type: "string" },
      secret: { type: "string", multiple: true }, public: { type: "boolean" }, "dry-run": { type: "boolean" },
      url: { type: "string" }, scope: { type: "string" }, name: { type: "string" }, settings: { type: "string" },
      help: { type: "boolean", short: "h" }, version: { type: "boolean" },
    },
  });
  if (v.version) { console.log(`mcpsmith ${VERSION}`); return 0; }
  const [cmd, a, b] = pos;
  const need = (n: number, usage: string) => { if (pos.length < n + 1) throw new UserError(`Usage: mcpsmith ${usage}`); };
  switch (v.help ? undefined : cmd) {
    case "audit": need(1, "audit SPEC"); await cmdAudit(a); return 0;
    case "init": need(1, "init SPEC [-o mcp.yaml] [--gemini --stories FILE]"); await cmdInit(a, v); return 0;
    case "build": need(2, "build SPEC mcp.yaml -o DIR"); return cmdBuild(a, b, v);
    case "test": need(1, "test DIR [--spec SPEC] [--call TOOL --args JSON]"); return cmdTest(a, v);
    case "auto": need(1, "auto SPEC -o DIR [--gemini --stories FILE]"); return cmdAuto(a, v);
    case "deploy":
      need(1, "deploy DIR --region REGION");
      if (!v.region) throw new UserError("deploy needs --region (e.g. europe-west1)");
      return deploy({ folder: a, service: v.service, region: v.region, project: v.project, pub: !!v.public,
        secret: (v.secret as string[] | undefined) ?? [], dryRun: !!v["dry-run"] });
    case "connect":
      need(1, "connect DIR [--url URL]");
      return connect({ folder: a, url: v.url, scope: v.scope === "user" ? "user" : "project", name: v.name, settings: v.settings });
    default: console.log(HELP); return cmd && !v.help ? 1 : 0;
  }
}

function isMain(): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isMain()) {
  main().then((code) => process.exit(code)).catch((e) => {
    if (e instanceof UserError || e?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || e?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      console.error(e.message);
      process.exit(1);
    }
    console.error(e);
    process.exit(1);
  });
}
