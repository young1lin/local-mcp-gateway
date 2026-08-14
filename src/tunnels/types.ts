export type AuthType = "key" | "password";

/** One SSH server, shared by every forwarding rule that names it. */
export interface SshConnDef {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  /** authType=key. May start with `~`, which is expanded at connect time. */
  keyPath?: string;
  /** authType=key, optional. */
  passphrase?: string;
  /** authType=password. */
  password?: string;
  /** `SHA256:…`, learned on first successful connect; a change refuses the connection. */
  hostKey?: string;
}

/** One local (-L) forward: 127.0.0.1:localPort -> targetHost:targetPort, through connectionId. */
export interface RuleDef {
  id: string;
  name: string;
  connectionId: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
  remark?: string;
  autoReconnect: boolean;
  /** Seconds between reconnect attempts. */
  reconnectInterval: number;
  /** "was running when the gateway last stopped" — the semantics managed.json already uses for MCPs. */
  enabled: boolean;
  /** Names of MCPs this tunnel serves. Display and guard rail only — never automation. */
  mcps: string[];
}

export type RuleState = "stopped" | "starting" | "up" | "reconnecting" | "error";
export type ConnState = "idle" | "connecting" | "connected" | "error";

/**
 * Why a tunnel operation failed, and therefore whether retrying could ever help.
 *
 * `auth` and `hostkey` are the ones that must NOT be retried: hammering a server with bad
 * credentials every 10 seconds earns a fail2ban ban or an account lockout, and a changed host key
 * needs a human to decide, not a loop.
 */
export type FailureKind = "auth" | "hostkey" | "network" | "port" | "config";

export class TunnelError extends Error {
  constructor(message: string, readonly kind: FailureKind, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "TunnelError";
  }
}

export function isRetryable(kind: FailureKind): boolean {
  // Only `network` is worth retrying — a transient blip may clear on its own. `port` is NOT: a port
  // held by another process will not free itself, so retrying only thrashes (and spawns netstat +
  // tasklist each attempt); it needs Force free, not a loop. `auth`/`hostkey`/`config` never were.
  return kind === "network";
}

/** Classify an unknown throw. A TunnelError already knows; anything else is treated as network. */
export function failureKind(err: unknown): FailureKind {
  return err instanceof TunnelError ? err.kind : "network";
}

export interface ForwardStats {
  sockets: number;
  bytesIn: number;
  bytesOut: number;
  channelFailures: number;
  /** Connections refused because the per-rule socket cap was reached. */
  refused: number;
  lastError?: string;
}

/** A rule row for the API and panel: its definition plus live state. */
export interface RuleRow extends RuleDef {
  state: RuleState;
  reason?: string;
  connectionName: string;
  startedAt?: string;
  /** Set when a reconnect succeeded — drives the stale-pool notice. */
  reconnectedAt?: string;
  sockets: number;
  bytesIn: number;
  bytesOut: number;
  channelFailures: number;
  /** Present when the local port is held by a foreign process. */
  portOwner?: { pid: number; name: string };
  /** Linked MCPs with their live state; `known: false` means the name has no registered MCP. */
  mcpRows: { name: string; state: string; known: boolean }[];
}

export interface ConnRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  state: ConnState;
  reason?: string;
  hostKey?: string;
  ruleCount: number;
  activeRules: number;
}
