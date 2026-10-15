// Inspect the tool surface an MCP client actually sees, in-memory (no network, no npm install).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { runtime } from "./runtime.js";
import { Spec, UserError } from "./spec.js";

export interface ToolInfo { name: string; description: string; inputSchema: any }

async function connect(factory: () => any) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await factory().connect(serverT);
  const client = new Client({ name: "mcpsmith", version: "0.1.0" });
  await client.connect(clientT);
  return client;
}

export async function listTools(factory: () => any): Promise<ToolInfo[]> {
  const client = await connect(factory);
  try {
    const all: ToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page: any = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) all.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? {} });
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  } finally { await client.close(); }
}

export async function callTool(factory: () => any, name: string, args: Record<string, unknown>): Promise<any> {
  const client = await connect(factory);
  try { return await client.callTool({ name, arguments: args }); } finally { await client.close(); }
}

export async function rawFactory(spec: Spec) {
  const rt = await runtime();
  return rt.createFactory({ spec, config: { name: "raw", baseUrl: spec.servers?.[0]?.url ?? "https://api.example.com", tools: null, auth: { type: "none" } } });
}

export async function folderFactory(folder: string) {
  const dir = resolve(folder);
  for (const f of ["openapi.json", "mcpsmith.config.json"]) {
    if (!existsSync(join(dir, f))) throw new UserError(`${folder}/${f} not found — run mcpsmith build first.`);
  }
  const spec = JSON.parse(readFileSync(join(dir, "openapi.json"), "utf8"));
  const config = JSON.parse(readFileSync(join(dir, "mcpsmith.config.json"), "utf8"));
  let register;
  const custom = join(dir, "custom-tools.mjs");
  if (existsSync(custom)) register = (await import(pathToFileURL(custom).href + `?t=${Date.now()}`)).register;
  const rt = await runtime();
  return rt.createFactory({ spec, config, register });
}

/** Rough size of the tool list a client puts in context: JSON characters / 4. */
export function approxTokens(tools: ToolInfo[]): number {
  return Math.floor(JSON.stringify(tools).length / 4);
}
