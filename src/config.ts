import { isLoopbackBindHost } from "./local-only.js";
import { dataPath } from "./datadir.js";
import { readSecureJson, writeSecureJson } from "./secure/statefile.js";
import { injectEnvStore } from "./secure/envstore.js";
import { DEFAULT_PORT, envListenPort } from "./port.js";

export { DEFAULT_PORT };

export interface ServerDef {
  type: string; // mysql | redis | pg | proc | echo
  [k: string]: unknown;
}
/**
 * Remove one server entry from gateway.config.json — the file leg of the panel's Delete for a
 * config-sourced MCP. Without it the runtime entry goes away but the next start resurrects the
 * MCP from the file, which is why the panel used to hide Delete for them entirely.
 *
 * Only the named key is removed; the rest of the file is re-stringified from the parsed object, so
 * every other entry keeps its `${ENV}` credential references verbatim. The write is atomic — a
 * torn config is the one file this gateway cannot boot through. Returns false when neither the
 * file nor the entry has it (nothing to remove; the caller proceeds with the runtime delete).
 */
export function removeConfigServer(name: string, path = dataPath("gateway.config.json")): boolean {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = readSecureJson<Record<string, unknown>>(path);
    if (!raw) return false;
    const servers = raw.servers;
    if (!servers || typeof servers !== "object" || (servers as Record<string, unknown>)[name] === undefined) {
      return false;
    }
  } catch {
    return false; // missing or unreadable — nothing to edit
  }
  const servers = { ...(raw!.servers as Record<string, unknown>) };
  delete servers[name];
  writeSecureJson(path, { ...raw!, servers }); // sealed, like every state write
  return true;
}

export interface GatewayConfig {
  port: number;
  host: string;
  token: string;
  /** Name of the env var the token came from. Safe to show — it is what client configs should read. */
  tokenEnv: string;
  servers: Record<string, ServerDef>;
}

/**
 * A missing port must not reach `listen()` as undefined — node then binds an arbitrary free port, so
 * the gateway comes up looking healthy on an address no client was ever pointed at. A malformed one is
 * refused for the same reason: silently listening somewhere else is worse than not starting.
 *
 * `MCP_GATEWAY_PORT` wins over the file, so `lmg start --port N` (which sets that env on the child)
 * actually changes where this process listens.
 */
function resolvePort(v: unknown): number {
  const fromEnv = envListenPort();
  if (fromEnv !== undefined) return fromEnv;
  if (process.env.MCP_GATEWAY_PORT) {
    throw new Error(
      `MCP_GATEWAY_PORT ${JSON.stringify(process.env.MCP_GATEWAY_PORT)} is not usable: ` +
        `give an integer between 1 and 65535.`,
    );
  }
  if (v === undefined) return DEFAULT_PORT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new Error(
      `port ${JSON.stringify(v)} is not usable: give an integer between 1 and 65535, ` +
        `or omit it to listen on ${DEFAULT_PORT}.`,
    );
  }
  return v;
}

function resolveStr(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? "");
}

/** Expand `${ENV_VAR}` references in ONE string — the build-time step of the credential model,
 *  shared with the tunnel connections (SSH password/passphrase) so tunnels.json can hold refs
 *  exactly like gateway.config.json and managed.json do. */
export function resolveEnvRefs(value: string): string {
  return resolveStr(value);
}
function resolveValue(v: unknown): unknown {
  if (typeof v === "string") return resolveStr(v);
  if (Array.isArray(v)) return v.map(resolveValue);
  if (v && typeof v === "object") return resolveObj(v as Record<string, unknown>);
  return v;
}
function resolveObj(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = resolveValue(v);
  return out;
}

/** True for a value that is exactly one `${ENV_VAR}` reference — i.e. a secret held in .env, not inline. */
export function isEnvRef(v: unknown): boolean {
  return typeof v === "string" && /^\$\{[A-Z0-9_]+\}$/.test(v);
}

/**
 * Expand every `${ENV_VAR}` reference in a server definition.
 *
 * Deliberately NOT done at config-load time: the registry (and therefore the admin panel, and
 * anything persisted to managed.json as an override) holds the definition exactly as authored, so
 * `${MYSQL_PASS}` stays a reference instead of being written back to disk as plaintext. Only
 * the adapter, at build time, sees the real credential.
 */
export function resolveDef(def: ServerDef): ServerDef {
  return resolveObj(def as Record<string, unknown>) as ServerDef;
}

export function loadConfig(path = dataPath("gateway.config.json")): GatewayConfig {
  // The sealed env store (where bootstrap seeds the token) replaces the old plaintext .env: its
  // values land in process.env here, never overriding what the environment already set, so the
  // `${ENV_VAR}` build-time expansion keeps resolving exactly as before.
  injectEnvStore();
  const raw = readSecureJson<Record<string, unknown>>(path);
  if (raw === undefined) {
    throw new Error(`${path}: no config file — run 'lmg start' once (it seeds one) or 'lmg import' a backup`);
  }
  // Structure gate before any field is read: a missing `servers` used to die as
  // "Cannot convert undefined or null to object" and a SCALAR servers value booted a gateway with
  // zero MCPs, silently healthy. Name the file's field, not the TypeError.
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object at the top level`);
  }
  if (raw.servers === undefined) raw.servers = {};
  if (!raw.servers || typeof raw.servers !== "object" || Array.isArray(raw.servers)) {
    throw new Error(`${path}: "servers" must be an object of name -> definition`);
  }
  if (typeof raw.tokenEnv !== "string" || !raw.tokenEnv.trim()) {
    throw new Error(`${path}: "tokenEnv" must name the env var holding the auth token`);
  }
  // Omitted means loopback: there is exactly one sensible bind address for this gateway, and leaving it
  // undefined used to mean "every interface" — the opposite.
  const host = raw.host === undefined ? "127.0.0.1" : String(raw.host);
  // Refused at load, not warned about: a gateway holding live DB credentials and third-party API keys
  // has no business being offered to another machine, and `0.0.0.0` is how that happens by accident.
  if (!isLoopbackBindHost(host)) {
    throw new Error(
      `host ${JSON.stringify(host)} is not local: this gateway serves only its own machine. ` +
        `Use 127.0.0.1 — "0.0.0.0" binds every interface. To reach it from elsewhere, forward the port over SSH.`,
    );
  }
  const token = process.env[raw.tokenEnv as string];
  if (!token) throw new Error(`Missing token env var: ${raw.tokenEnv}`);
  const servers: Record<string, ServerDef> = {};
  for (const [name, def] of Object.entries(raw.servers)) {
    servers[name] = def as ServerDef; // kept unresolved on purpose — see resolveDef()
  }
  return { port: resolvePort(raw.port), host, token, tokenEnv: String(raw.tokenEnv), servers };
}
