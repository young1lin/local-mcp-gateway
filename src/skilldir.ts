import { fileURLToPath } from "node:url";

/**
 * Where the shipped AI skill lives in this package: `.agents/skills/local-mcp-gateway/`. Resolved
 * relative to this module so it works under both tsx (src/) and the build (dist/) — both sit one
 * level below the package root. Node builtins only: cli.ts imports this and must stay light.
 */
export function skillDir(): string {
  return fileURLToPath(new URL("../.agents/skills/local-mcp-gateway", import.meta.url));
}
