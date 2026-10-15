// Ask Gemini to propose the curation. Gemini only proposes: every suggestion is validated
// against the spec, risky operations are never switched on, and everything lands in mcp.yaml
// for a human to review.
import type { ArgChange, ToolOverride } from "./curate.js";
import { Operation, UserError, opText } from "./spec.js";

export const DEFAULT_MODEL = process.env.MCPSMITH_GEMINI_MODEL || "gemini-3.8-flash";
export const MAX_TOOLS = 15;
const NAME_RE = /^[a-z][a-z0-9_]{1,55}$/;

export const SCHEMA = {
  type: "object",
  properties: {
    stories: { type: "array", description: "Agent stories used, each 'As an agent, given X, I use Y to achieve Z'.", items: { type: "string" } },
    tools: {
      type: "array",
      description: `ONLY the operations to include, at most ${MAX_TOOLS}.`,
      items: {
        type: "object",
        properties: {
          operation_id: { type: "string" },
          name: { type: "string", description: "snake_case verb_noun, no versions" },
          description: { type: "string", description: "What it does, when to use it, when NOT to. 1-3 sentences." },
          reason: { type: "string", description: "Which story needs it, in a few words." },
          args: {
            type: "array",
            items: {
              type: "object",
              properties: {
                param: { type: "string" },
                rename: { type: "string" },
                description: { type: "string" },
                hide: { type: "boolean" },
                default: { type: "string", description: "Value to send when hidden, as text." },
              },
              required: ["param"],
            },
          },
        },
        required: ["operation_id", "name", "description", "reason"],
      },
    },
  },
  required: ["stories", "tools"],
};

export function buildPrompt(title: string, ops: Operation[], stories: string[]): string {
  const block = stories.length
    ? "Agent stories this server must serve:\n" + stories.map((s) => `- ${s}`).join("\n")
    : "No agent stories were given. First write the 3-5 most valuable agent stories for this API " +
      "('As an agent, given X, I use Y to achieve Z'), then curate for those.";
  const lines = ops.map((o) => JSON.stringify({
    operation_id: o.operationId, method: o.method, path: o.path, description: opText(o).slice(0, 300),
    flags: o.risky ? o.findings.slice(0, 2) : [],
    params: o.params.slice(0, 25).map((p) => ({ name: p.name, in: p.location, required: p.required, type: p.type, description: p.description.slice(0, 120) })),
  }));
  return `You are curating an MCP server generated from an OpenAPI spec. An LLM agent will see
every tool you include on every turn, so fewer, clearer tools work better than mirroring the API.

${block}

Rules:
- Include ONLY operations the stories need (at most ${MAX_TOOLS}). Exclude everything else.
- Never include destructive, admin, internal or deprecated operations unless a story clearly needs one.
- name: snake_case verb_noun (list_orders, create_refund), no version numbers or HTTP verbs as prefixes.
- description: what it does, when to use it, and when NOT to (point to the sibling tool to use instead).
- args: rename cryptic params to self-explaining names; hide params an agent should never set
  (pagination, API versions, internal flags) and give a default only when one is needed.
  Never hide a required param without a default.

API: ${title}
Operations (JSON lines):
${lines.join("\n")}
`;
}

export type Generate = (prompt: string, model: string) => Promise<string>;

export const generateWithGemini: Generate = async (prompt, model) => {
  if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI)) {
    throw new UserError("Set GEMINI_API_KEY (get one at https://aistudio.google.com/apikey), " +
      "or GOOGLE_GENAI_USE_VERTEXAI=true with GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION for Vertex AI.");
  }
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({});
  try {
    const res = await ai.models.generateContent({
      model, contents: prompt,
      config: { responseMimeType: "application/json", responseJsonSchema: SCHEMA, temperature: 0.2 },
    });
    return res.text ?? "{}";
  } catch (e: any) {
    const cause = e?.cause?.code ? ` (${e.cause.code})` : "";
    throw new UserError(`Gemini request failed${cause}: ${String(e?.message ?? e).split("\n")[0]}\n` +
      "Check GEMINI_API_KEY, your network, and the model name (--model or MCPSMITH_GEMINI_MODEL).");
  }
};

function coerce(value: unknown, type: string): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value);
  if (type === "integer") { const n = parseInt(s, 10); return Number.isFinite(n) ? n : undefined; }
  if (type === "number") { const n = Number(s); return Number.isFinite(n) ? n : undefined; }
  if (type === "boolean") return ["true", "1", "yes"].includes(s.toLowerCase());
  return s;
}

export async function propose(title: string, ops: Operation[], stories: string[], model = DEFAULT_MODEL,
  generate: Generate = generateWithGemini): Promise<{ overrides: Record<string, ToolOverride>; stories: string[]; warnings: string[] }> {
  const raw = await generate(buildPrompt(title, ops, stories), model);
  let data: any;
  try { data = JSON.parse(raw); } catch (e: any) { throw new UserError(`Gemini returned invalid JSON: ${e.message}`); }
  const byId = new Map(ops.map((o) => [o.operationId, o]));
  const overrides: Record<string, ToolOverride> = {};
  const warnings: string[] = [];
  const names = new Set<string>();
  for (const t of (data.tools ?? []).slice(0, MAX_TOOLS)) {
    const oid = String(t.operation_id ?? "");
    const op = byId.get(oid);
    if (!op) { warnings.push(`Gemini suggested unknown operation '${oid}' — ignored`); continue; }
    let name = String(t.name ?? "").trim().toLowerCase();
    if (!NAME_RE.test(name)) { warnings.push(`${oid}: Gemini's name '${name}' isn't a valid tool name — kept the heuristic one`); name = ""; }
    if (name && names.has(name)) { warnings.push(`${oid}: name '${name}' already used — kept the heuristic one`); name = ""; }
    if (name) names.add(name);
    const params = new Map(op.params.map((p) => [p.name, p]));
    const args: Record<string, ArgChange> = {};
    for (const a of t.args ?? []) {
      const p = params.get(a.param);
      if (!p) { warnings.push(`${oid}: Gemini referred to unknown param '${a.param}' — ignored`); continue; }
      const entry: ArgChange = {};
      if (a.hide) {
        const d = coerce(a.default, p.type);
        if (p.required && d === undefined) warnings.push(`${oid}.${a.param}: required, can't hide without a default — left visible`);
        else { entry.hide = true; if (d !== undefined) entry.default = d; }
      }
      if (!entry.hide) {
        const rename = String(a.rename ?? "").trim();
        if (rename && rename !== a.param && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(rename)) entry.rename = rename;
        if (a.description) entry.description = String(a.description).trim();
      }
      if (Object.keys(entry).length) args[a.param] = entry;
    }
    const ov: ToolOverride = { include: !op.risky, description: String(t.description ?? "").trim(), reason: String(t.reason ?? "").trim(), args };
    if (name) ov.name = name;
    if (op.risky) {
      ov.riskySuggested = true;
      warnings.push(`${oid}: Gemini wanted it but it's flagged risky — left excluded for you to decide`);
    }
    overrides[oid] = ov;
  }
  return { overrides, stories: (data.stories ?? []).map(String), warnings };
}
