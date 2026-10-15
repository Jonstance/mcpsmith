// Typed bridge to the JavaScript runtime that also ships inside every generated server.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNTIME_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "mcpsmith-runtime.mjs");

export interface Runtime {
  buildTools(spec: any, config: any): any[];
  createFactory(o: { spec: any; config: any; register?: (server: any, helpers: any) => void }): () => any;
}

let cached: Runtime | undefined;
export async function runtime(): Promise<Runtime> {
  cached ??= (await import(pathToFileURL(RUNTIME_PATH).href)) as Runtime;
  return cached;
}
