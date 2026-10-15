# mcpsmith

**Turn an OpenAPI spec into a curated, shippable MCP server.** Gemini curates it, Cloud Run hosts it, and Gemini CLI uses it.

```bash
npx mcpsmith auto openapi.yaml -o my-server --gemini
```

Converting a whole REST API into MCP tools is easy. The result is a bad agent experience: hundreds of tools, cryptic names, admin endpoints exposed, and a tool list that eats the model's context on every turn. mcpsmith automates everything around the part that matters, which is **curation**, and keeps you in charge of the decisions.

```
openapi.yaml ─ audit ─▶ what's wrong (risky ops, weak names/descriptions, token cost)
     │
     └─ init --gemini ─▶ mcp.yaml  ◀── Gemini proposes from your agent stories; you review
                            │
              build ─▶ my-server/  (Node MCP server, auth, Dockerfile, its tool list checked)
                            │
           deploy ─▶ Cloud Run (private)      connect ─▶ Gemini CLI
```

Node 20+. Generated servers use the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (v2, MCP spec 2026-07-28) and speak Streamable HTTP or stdio.

## Commands

| | |
|---|---|
| `mcpsmith audit SPEC` | What a raw conversion exposes: tool count, a rough token cost of the tool list, plus findings. Findings cover DELETEs, admin/internal or deprecated routes, missing or weak descriptions, versioned/`__` operationIds, and cryptic or undocumented params. |
| `mcpsmith init SPEC [--gemini --stories stories.txt]` | Drafts `mcp.yaml`, the curation file. With `--gemini`, Gemini picks the tools your agent stories need, then names, describes and reshapes them. Without it, heuristics do a safer, plainer draft. |
| `mcpsmith build SPEC mcp.yaml -o DIR [--install]` | Validates the curation and generates the server, then shows the exact tools a client will see, with a before → after comparison. |
| `mcpsmith deploy DIR --region R` | Deploys to Cloud Run with `gcloud run deploy --source`. The service is **private** (callers need `roles/run.invoker`) and credentials come from Secret Manager. Add `--dry-run` to print the command. |
| `mcpsmith connect DIR [--url URL]` | Adds the server to Gemini CLI (`.gemini/settings.json`). It's local over stdio by default; pass `--url` for a remote server. |

`mcpsmith auto SPEC -o DIR [--gemini]` runs audit → init → build in one go. `mcpsmith test DIR --call TOOL --args '{…}'` hits the real API.

## Gemini curation

Write the jobs an agent should do, one per line:

```text
# stories.txt
As an agent, given a customer's email, I find their orders and refund one of them.
As an agent, given a refund ID, I check whether the refund went through.
```

```bash
export GEMINI_API_KEY=...            # https://aistudio.google.com/apikey  (or Vertex AI: GOOGLE_GENAI_USE_VERTEXAI=true)
npx mcpsmith init openapi.yaml --gemini --stories stories.txt
```

Gemini only **proposes**, and every suggestion is checked against the spec:
- unknown operations and parameters are dropped;
- invalid or duplicate names fall back to the heuristic name;
- a required param is never hidden without a default;
- **risky operations are never switched on**: they stay `include: false` with a note, for you to decide.

The resulting `mcp.yaml` lists the stories and Gemini's reasoning per tool. Leave out `--stories` and Gemini proposes the stories first. The default model is `gemini-3.8-flash`; use `--model` or `MCPSMITH_GEMINI_MODEL` to change it.

## The curation file

```yaml
auth:
  type: login                        # none | bearer | api_key | basic | login
  login_url: /api/v1/auth/login      # key + secret → short-lived bearer token
  username_env: API_KEY
  password_env: API_SECRET
  token_path: responseBody.accessToken
  expires_in_path: responseBody.expiresIn

tools:
  list_orders_v2__get:               # the spec's operationId
    include: true
    name: find_orders
    description: "Find a customer's orders by email. Call this before refunding."
    args:
      q:   {rename: customer_email, description: "Customer email address"}
      lim: {hide: true, default: 20}
  delete_customer:
    include: false
```

Credentials live in environment variables on the server. The model never sees them and can't set them. `login` refreshes the token before expiry and retries once after a 401. Specs with more than 30 safe operations start with every tool excluded, so you allow-list deliberately.

## The generated server

```
my-server/
  server.mjs              starts the server (HTTP on PORT, or MCP_TRANSPORT=stdio)
  mcpsmith.config.json    your curation, compiled
  mcpsmith-runtime.mjs    OpenAPI → MCP tools, requests and auth (no dependency on the mcpsmith CLI)
  custom-tools.mjs        your hand-written composite tools; never overwritten
  openapi.json  package.json  Dockerfile  .env.example  README.md
```

Each tool's input schema comes from the spec. `$ref` and `allOf` are resolved, `nullable` is handled, and read-only fields are dropped, so the SDK validates arguments before any request is made. Request bodies can be JSON, form-encoded (nested values use bracket notation) or multipart.

## Ship it

```bash
npx mcpsmith build openapi.yaml mcp.yaml -o my-server
npx mcpsmith deploy my-server --region europe-west1      # prints the Secret Manager commands to run once
gcloud run services proxy my-server --region europe-west1 --port 3000
npx mcpsmith connect my-server --url http://localhost:3000/mcp
gemini                                                    # then /mcp to see the tools
```

Or run locally: `(cd my-server && npm install)`, `npx mcpsmith connect my-server`, export the credential variables, and start `gemini`.

Gemini CLI asks before each tool call (`trust: false`). The MCP 2026-07-28 spec is stateless, so Cloud Run scales the server like any web service.

## Tested against

- Swagger Petstore (19 operations).
- Stripe's public spec (612 operations; a raw conversion's tool list is roughly 435k tokens, and 3 allow-listed tools cut that to about 1.8k).
- `examples/`: a shop API plus a reviewed `mcp.yaml`. `npm test` runs generated servers against fake APIs, covering the login token exchange, renamed and hidden arguments, input validation, form encoding and 401 handling.

Token figures are rough (JSON characters ÷ 4).

## Develop

```bash
npm install
npm test          # builds, then runs node:test
npm link          # puts `mcpsmith` on your PATH
```

## Limits

OpenAPI 3.x only. Schemas nested deeper than 6 levels are loosened to "any". Naming and risk detection are heuristics, and Gemini's output is a proposal. **Review `mcp.yaml` before you ship.**

MIT licensed. Built for DevFest Warri 2026 by [Constance Etiosa](https://constanceetin.xyz).
