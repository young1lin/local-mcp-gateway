import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { log } from "./log.js";
import { chmodPrivate, PRIVATE_FILE } from "./privfs.js";

/**
 * Write a file atomically, and tell the caller when it could not be written.
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

/** Rename over an existing file can fail TRANSIENTLY on Windows — the target is held for a moment
 *  by antivirus, the search indexer or a backup agent (the entire reason graceful-fs exists; this
 *  repo has felt it in the field, see calls.ts's EPERM retry). Back off and retry; a persistent
 *  failure still surfaces through the throw. The sleep is Atomics.wait — this helper is synchronous
 *  by contract, and timers cannot pause a sync function. */
function renameRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EEXIST" || code === "EBUSY";
      if (!transient || attempt >= 4) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

/** A temp name unique to THIS writer: two concurrent writers (two instances sharing a data dir, a
 *  test racing a live gateway) used to share `<path>.tmp`, and whichever renamed first turned the
 *  other's rename into an ENOENT. */
function tmpPath(path: string): string {
  return `${path}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
}

function writeAtomic(path: string, data: string): void {
  const tmp = tmpPath(path);
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: PRIVATE_FILE });
    renameRetry(tmp, path);
    chmodPrivate(path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
    const message = (err as Error).message;
    log("error", "atomic save failed", { err: message, path });
    throw new Error(`could not save ${path}: ${message}`);
  }
}

export function writeJsonAtomic(path: string, data: unknown): void {
  writeAtomic(path, JSON.stringify(data, null, 2));
}

/** The same contract for plain text (.env): tmp + rename + the transient-rename retry. A torn .env
 *  is nastier than a torn JSON file — the token line can be cut mid-value and the next boot starts
 *  with a credential nothing can authenticate against. */
export function writeTextAtomic(path: string, text: string): void {
  writeAtomic(path, text);
}
