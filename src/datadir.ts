import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The one place this gateway keeps its state: `.env`, `gateway.config.json`, `managed.json`,
 * `tunnels.json`, `logs/`. Read fresh from the env each call so a test that sets
 * `MCP_GATEWAY_HOME` is honored without a module reload.
 *
 * Why a fixed home and not cwd: `npx` / `npm link` can be invoked from any directory, so a
 * cwd-relative token would scatter across projects. And the npx cache (`_npx/<hash>/`) is
 * ephemeral — it is cleared on update and version-keyed — so "install directory" can never
 * hold the token durably. `~/.mcp-gateway` is found regardless of cwd and survives npx churn,
 * which is what makes the token "global" the way the panel and the skill expect.
 */
export function dataDir(): string {
  return process.env.MCP_GATEWAY_HOME || join(homedir(), ".mcp-gateway");
}

/** A path inside the data dir. */
export function dataPath(...segments: string[]): string {
  return join(dataDir(), ...segments);
}
