import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * User-level bin dirs that interactive shells usually have on PATH, but a detached `lmg start`
 * (or Cursor's agent shell) often does not. uv/uvx lands in `~/.local/bin` on Windows; npm's
 * global bins in `%APPDATA%\npm`. Without these, `uvx mcp-server-fetch` fails as
 * 「不是内部或外部命令」 even though the binary is installed.
 */
export function extraBinDirs(): string[] {
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin"),
    process.env.APPDATA ? join(process.env.APPDATA, "npm") : "",
    join(home, ".cargo", "bin"),
  ];
  return candidates.filter((d) => d && existsSync(d));
}

function sameDir(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Prepend existing extra bin dirs that are missing from `path`, so a daemon inherits a login-like PATH. */
export function loginPath(path = process.env.PATH ?? "", extras = extraBinDirs()): string {
  const parts = path.split(delimiter).filter(Boolean);
  const missing = extras.filter((d) => !parts.some((p) => sameDir(p, d)));
  return missing.length ? [...missing, ...parts].join(delimiter) : path;
}
