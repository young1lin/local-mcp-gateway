import { existsSync, readFileSync, rmSync } from "node:fs";
import { dataPath } from "../datadir.js";
import { log } from "../log.js";
import { readSecureJson, writeSecureJson } from "./statefile.js";

/**
 * The encrypted replacement for the data-dir '.env'.
 *
 * Secrets used to sit in the data dir's '.env' as plaintext KEY=VALUE lines. They now live in
 * 'env.json' - a sealed envelope holding a JSON object of key -> value, opened only by the
 * machine key. A legacy '.env' is consumed on first read: parsed, merged into the sealed store,
 * verified, and only then deleted, so the plaintext copy cannot survive past the boot that saw it.
 *
 * '${ENV_VAR}' references in server definitions keep working unchanged: the store is injected
 * into process.env at config load (without overriding anything already set - dotenv semantics),
 * and the existing build-time expansion resolves against process.env as before.
 */

/** Where the encrypted env store lives. */
export function envStorePath(): string {
  return dataPath("env.json");
}

/** Parse .env-style text: KEY=value, 'export KEY=value', # comments, optional matching quotes. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

function readStore(path: string): Record<string, string> {
  const raw = readSecureJson<Record<string, unknown>>(path);
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Overwrite the sealed store in one shot. */
export function writeEnvStore(store: Record<string, string>, path = envStorePath()): void {
  writeSecureJson(path, store);
}

/**
 * The sealed env store, with any legacy plaintext '.env' folded in and removed.
 *
 * Deletion is verify-then-delete: the just-written sealed store is read back and must contain
 * every legacy key with its exact value before the plaintext file goes. A failed seal leaves
 * '.env' in place and the merged values readable in-process, so the boot still works and the next
 * boot retries.
 */
export function readEnvStore(path = envStorePath()): Record<string, string> {
  const store = readStore(path);
  const legacyPath = dataPath(".env");
  if (!existsSync(legacyPath)) return store;
  const legacy = parseEnvText(readFileSync(legacyPath, "utf8"));
  const merged = { ...legacy, ...store }; // sealed values win: they were written later
  try {
    writeEnvStore(merged, path);
    const verify = readStore(path);
    const safe = Object.entries(legacy).every(([k, v]) => verify[k] === v);
    if (safe) {
      rmSync(legacyPath, { force: true });
      log("info", "moved the plaintext .env into the encrypted store", { keys: Object.keys(legacy).length });
    }
  } catch (err) {
    log("warn", "could not migrate the plaintext .env; leaving it in place", { err: (err as Error).message });
  }
  return merged;
}

/** Set 'key' only when absent; true when it was written (the ensureEnvKey contract). */
export function setEnvDefault(key: string, value: string, path = envStorePath()): boolean {
  const store = readEnvStore(path);
  if (store[key] !== undefined) return false;
  store[key] = value;
  writeEnvStore(store, path);
  return true;
}

/**
 * Put the sealed store into process.env - the load-time step of the credential model. Existing
 * variables are never overridden: what the OS or the service manager injected wins.
 */
export function injectEnvStore(path = envStorePath()): void {
  const store = readEnvStore(path);
  for (const [k, v] of Object.entries(store)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
