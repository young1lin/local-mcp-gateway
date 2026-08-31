import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { skillDir } from "./skilldir.js";

/**
 * Recursive copy without fs.cpSync: on some Windows setups cpSync fails with EIO "Access is
 * denied" on a destination directory it just created (its `\\?\`-prefixed internal mkdir, most
 * likely intercepted by antivirus), while the plain mkdirSync/copyFileSync pair sails through
 * the same tree. Verified the failure is cpSync-specific on Node 22 / Win 11; the manual walk
 * is the portable form.
 */
function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    // A symlink in the shipped skill would be a packaging bug; skip rather than follow it.
  }
}

/**
 * Copy the shipped skill into the user-level directories an AI tool actually scans, so installing
 * the gateway ends with the agent able to drive it:
 *
 *   ~/.agents/skills/local-mcp-gateway/   the tool-agnostic convention
 *   ~/.claude/skills/local-mcp-gateway/   Claude Code's user-level path
 *   ~/.cursor/skills/local-mcp-gateway/   Cursor's user-level path
 *
 * Node builtins only (see cli.ts's module-diet note). Idempotent: a re-run replaces the copies,
 * so upgrading the gateway and re-installing drops exactly the newer package's files — never a
 * merge with stale ones. Returns the targets written, for the CLI to print.
 */
export function installSkill(home: string = homedir(), src: string = skillDir()): string[] {
  if (!existsSync(src)) {
    throw new Error(`skill not found in this package: ${src}`);
  }
  const targets = [
    join(home, ".agents", "skills", "local-mcp-gateway"),
    join(home, ".claude", "skills", "local-mcp-gateway"),
    join(home, ".cursor", "skills", "local-mcp-gateway"),
  ];
  for (const t of targets) {
    mkdirSync(dirname(t), { recursive: true });
    // Stage the whole copy BESIDE the target, then swap. The old order (rm, then copy) left the
    // install deleted-but-not-replaced whenever copyTree hit this environment's documented EIO
    // (see copyTree's comment) — a half install with no rollback. A failed stage leaves the
    // previous install untouched; only a complete copy is swapped in.
    const staged = `${t}.staged-${process.pid}`;
    rmSync(staged, { recursive: true, force: true });
    try {
      copyTree(src, staged);
      rmSync(t, { recursive: true, force: true });
      renameSync(staged, t);
    } catch (err) {
      rmSync(staged, { recursive: true, force: true });
      throw new Error(`could not install skill to ${t}: ${(err as Error).message}`);
    }
  }
  return targets;
}
