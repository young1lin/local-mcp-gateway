import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { isLoopbackBindHost } from "./local-only.js";
import { dataPath } from "./datadir.js";
import { DEFAULT_PORT, envListenPort } from "./port.js";

export { DEFAULT_PORT };

export interface ServerDef {
  type: string; // mysql | redis | pg | proc | echo
  [k: string]: unknown;
}
export interface GatewayConfig {
  port: number;
  host: string;
  token: string;
  /** Name of the env var the token came from. Safe to show — it is what client configs should read. */
  tokenEnv: string;
  user: string;
  pass: string;
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
  // Load the data-dir .env (where bootstrap seeds the token), not a cwd-relative one.
  loadDotenv({ path: dataPath(".env") });
  const raw = JSON.parse(readFileSync(path, "utf8"));
  // Omitted means loopback: there is exactly one sensible bind address for this gateway, and leaving it
  // undefined used to mean "every interface" — the opposite.
  const host = raw.host === undefined ? "127.0.0.1" : raw.host;
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
  // Panel login defaults to admin/admin; override via GATEWAY_USER / GATEWAY_PASS.
  const user = process.env.GATEWAY_USER || "admin";
  const pass = process.env.GATEWAY_PASS || "admin";
  return { port: resolvePort(raw.port), host, token, tokenEnv: String(raw.tokenEnv), user, pass, servers };
}
