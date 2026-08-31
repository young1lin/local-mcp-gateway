import { existsSync, readFileSync } from "node:fs";
import { writeTextAtomic } from "../atomic-json.js";
import { log } from "../log.js";
import { isSealed, seal, unseal } from "./envelope.js";
import { MASTER_KEY_ENV, masterKeyCandidates } from "./key.js";

/**
 * Encrypted JSON state - the ONLY way gateway state reaches disk.
 *
 * Every state file (gateway.config.json, managed.json, tunnels.json, env.json) is an AES-256-GCM
 * envelope sealed under the machine-bound master key (see key.ts). On disk there is ciphertext and
 * the envelope's fields - nothing else. Plaintext exists in exactly two places: inside a running
 * gateway, after load; and wherever the operator explicitly puts it ('lmg export').
 *
 * Reading accepts BOTH envelopes and legacy plaintext JSON: a pre-encryption install (or a
 * hand-authored file dropped into the data dir) is read, then immediately re-saved sealed - the
 * migration is "boot once and the plaintext is gone". Writing only ever produces an envelope.
 */

/** Read a state file. undefined when the file does not exist. Throws when it cannot be opened. */
export function readSecureJson<T = unknown>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(path + ": not valid JSON: " + (err as Error).message);
  }
  if (!isSealed(raw)) {
    // Legacy plaintext (pre-encryption install, or a hand-authored file). Seal it now so the
    // plaintext window closes on first read; when no key is available at all, keep serving the
    // plaintext read-only rather than failing the boot on a file we cannot protect anyway.
    try {
      writeSecureJson(path, raw);
      log("info", "sealed a plaintext state file", { path });
    } catch (err) {
      log("warn", "could not seal a plaintext state file", { path, err: (err as Error).message });
    }
    return raw as T;
  }
  const sealed = raw;
  let last: Error | undefined;
  for (const cand of masterKeyCandidates()) {
    try {
      return JSON.parse(unseal(cand.key, sealed)) as T;
    } catch (err) {
      last = err as Error;
    }
  }
  throw new Error(
    path + ": cannot decrypt with this machine's key (sealed by key source '" + sealed.keySource + "'). " +
      "The file was copied from another machine, or the OS credential holding the key changed. " +
      "Run 'lmg export' on the machine that sealed it and 'lmg import' here, or set " + MASTER_KEY_ENV + ".",
  );
}

/** Write a state file as a sealed envelope, atomically (tmp + rename - see atomic-json.ts). */
export function writeSecureJson(path: string, data: unknown): void {
  const cand = masterKeyCandidates()[0];
  const payload = JSON.stringify(data, null, 2);
  writeTextAtomic(path, JSON.stringify(seal(cand.key, cand.id, payload), null, 2));
}
