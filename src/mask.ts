import { isEnvRef, type ServerDef } from "./config.js";

/**
 * Secret masking for the admin panel.
 *
 * The panel has to show and edit a server definition, and a definition can hold a live DB password.
 * So secrets go out as a sentinel, and a PUT that sends the sentinel back unchanged keeps whatever was
 * stored — the browser never receives the credential, and editing an unrelated field cannot destroy
 * it. `${ENV_VAR}` references are not secrets (the value lives in .env) and pass through as-is.
 */
const MASK = "••••••••";
// `passphrase` is here for SSH connection defs, which go through this same round-trip: a key's
// passphrase is every bit as much a credential as a DB password.
const SECRET_KEY_RE = /^(password|pass|passphrase|secret|token)$/i;
const SECRET_ENV_RE = /(pass|secret|token|key|credential)/i;
/** Header names whose value is a credential. `auth` is the one that matters: a remote MCP's API key
 *  travels in `Authorization`, exactly as a proc MCP's travels on its command line. Over-matching is
 *  harmless — a masked value the panel sends back is restored from what is stored. */
const SECRET_HEADER_RE = /(auth|api-?key|token|secret|credential|cookie)/i;
const URL_KEYS = new Set(["url", "connectionstring", "dsn", "proxy"]);
/** `scheme://user:password@host/...` — capture everything up to the password. */
const URL_PASSWORD_RE = /^([a-zA-Z][\w+.-]*:\/\/[^:/@\s]*):([^@/\s]*)@/;

/**
 * A credential sitting on a command line: `--token=xyz`, `--api-key xyz`, `-phunter2`.
 *
 * proc MCPs are launched from a `command` string, and that is exactly where a third-party server's
 * key tends to go — so masking `env` while handing `command` back verbatim protected the less
 * likely half and gave a false impression about the other. Group 1 is the flag plus its separator,
 * group 2 the value.
 */
const CMD_SECRET_RE = /(--?[a-z0-9-]*(?:pass|secret|token|key|credential)[a-z0-9-]*[= ]|(?<![\w-])-p(?=\S))(\S+)/gi;

function maskCommand(cmd: string): string {
  return cmd.replace(CMD_SECRET_RE, (m, head: string, value: string) => (isEnvRef(value) ? m : head + MASK));
}

/** Put stored command-line credentials back, matching them up in order, so the rest of the command
 *  stays editable. A slot with nothing behind it keeps the sentinel and is dropped by dropSentinel. */
function unmaskCommand(next: string, current: unknown): string {
  if (!next.includes(MASK)) return next;
  const stored: string[] = [];
  if (typeof current === "string") for (const m of current.matchAll(CMD_SECRET_RE)) stored.push(m[2]);
  let i = 0;
  return next.replace(CMD_SECRET_RE, (m, head: string, value: string) => {
    const was = stored[i++];
    if (value !== MASK) return m;
    return was === undefined ? m : head + was;
  });
}

/**
 * Definition fields holding a name→value map whose values can be credentials: a proc MCP's `env` and
 * an http MCP's request `headers`. A Map, not an object literal — a def field named `constructor`
 * would otherwise match through the prototype and be treated as one of these.
 */
const SECRET_RECORDS = new Map<string, RegExp>([
  ["env", SECRET_ENV_RE],
  ["headers", SECRET_HEADER_RE],
]);

function maskRecord(rec: Record<string, unknown>, secret: RegExp): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = !isEnvRef(v) && secret.test(k) && typeof v === "string" && v ? MASK : v;
  }
  return out;
}

function maskUrl(url: string): string {
  return url.replace(URL_PASSWORD_RE, (_m, head: string, pass: string) => (pass ? `${head}:${MASK}@` : `${head}:@`));
}

function urlPassword(url: string): string | undefined {
  return URL_PASSWORD_RE.exec(url)?.[2];
}

/** Put a stored URL's password back into an edited URL that still carries the sentinel. */
function unmaskUrl(next: string, current: unknown): string {
  if (urlPassword(next) !== MASK) return next;
  const currentPass = typeof current === "string" ? urlPassword(current) : undefined;
  if (currentPass === undefined) return next;
  return next.replace(URL_PASSWORD_RE, (_m, head: string) => `${head}:${currentPass}@`);
}

/** A definition safe to send to the browser: every secret replaced by the sentinel. */
export function maskDef(def: ServerDef): ServerDef {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def)) {
    if (isEnvRef(v)) { out[k] = v; continue; }
    if (SECRET_KEY_RE.test(k) && typeof v === "string" && v) { out[k] = MASK; continue; }
    if (URL_KEYS.has(k.toLowerCase()) && typeof v === "string") { out[k] = maskUrl(v); continue; }
    if (k === "command" && typeof v === "string") { out[k] = maskCommand(v); continue; }
    const secretNames = SECRET_RECORDS.get(k);
    if (secretNames && v && typeof v === "object") {
      out[k] = maskRecord(v as Record<string, unknown>, secretNames);
      continue;
    }
    out[k] = v;
  }
  return out as ServerDef;
}

/**
 * Delete anything still carrying the sentinel after restoration.
 *
 * A value that survives with dots in it is one there was nothing to restore from — the panel's type
 * dropdown submits a `url` against a stored mysql def that never had one, and a stored `password`
 * has no counterpart under the new shape. Persisting `••••••••` as the credential would replace a
 * working secret with dots and report 200; dropping the field instead leaves it unset, which
 * buildDef either ignores or rejects out loud.
 */
function dropSentinel(out: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && v.includes(MASK)) { delete out[k]; continue; }
    if (SECRET_RECORDS.has(k) && v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      for (const [ek, ev] of Object.entries(rec)) {
        if (typeof ev === "string" && ev.includes(MASK)) delete rec[ek];
      }
    }
  }
}

/** Restore masked values in an incoming edit from the definition currently stored. */
export function unmaskBody(body: Record<string, unknown>, current: ServerDef | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (current) {
    for (const [k, v] of Object.entries(out)) {
      if (SECRET_KEY_RE.test(k) && v === MASK && current[k] !== undefined) { out[k] = current[k]; continue; }
      if (URL_KEYS.has(k.toLowerCase()) && typeof v === "string") { out[k] = unmaskUrl(v, current[k]); continue; }
      if (k === "command" && typeof v === "string") { out[k] = unmaskCommand(v, current[k]); continue; }
      if (SECRET_RECORDS.has(k) && v && typeof v === "object") {
        const stored = (current[k] ?? {}) as Record<string, unknown>;
        const next: Record<string, unknown> = { ...(v as Record<string, unknown>) };
        for (const [ek, ev] of Object.entries(next)) {
          if (ev === MASK && stored[ek] !== undefined) next[ek] = stored[ek];
        }
        out[k] = next;
      }
    }
  }
  dropSentinel(out);
  return out;
}
