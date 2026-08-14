import { renameSync, rmSync, writeFileSync } from "node:fs";
import { log } from "./log.js";
import { chmodPrivate, PRIVATE_FILE } from "./privfs.js";

/**
 * Write a JSON file atomically, and tell the caller when it could not be written.
 *
 * `writeFileSync` truncates before it writes, so being killed mid-write — `taskkill /F`, or
 * index.ts's own 3s force-exit landing on a save that followed a panel edit — leaves the file empty
 * or torn. A loader that answers a parse failure with "empty" then
 * silently discards everything that was in it. A temp file renamed over the target is replaced whole
 * or not at all (rename is atomic on NTFS and POSIX).
 *
 * Throwing matters as much as the rename: a store that only logged let the admin API report 201
 * Created for a definition that never reached the disk.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: PRIVATE_FILE });
      renameSync(tmp, path);
      chmodPrivate(path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
    const message = (err as Error).message;
    log("error", "atomic save failed", { err: message, path });
    throw new Error(`could not save ${path}: ${message}`);
  }
}
