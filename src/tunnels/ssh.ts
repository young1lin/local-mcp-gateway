import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Duplex } from "node:stream";
import { log } from "../log.js";
import { TunnelError, type ConnState, type FailureKind, type SshConnDef } from "./types.js";

/**
 * ssh2 is imported on first use, never at boot.
 *
 * A gateway with no tunnels started must not pay for the library at all — the same discipline the DB
 * adapters follow with mysql2/ioredis/pg. Cached as a promise so concurrent first starts share one
 * import.
 */
let ssh2Promise: Promise<typeof import("ssh2")> | undefined;
export function loadSsh2(): Promise<typeof import("ssh2")> {
  if (!ssh2Promise) ssh2Promise = import("ssh2");
  return ssh2Promise;
}

/** Expand a leading `~` in a key path. The panel's own default is `~/.ssh/id_rsa`. */
export function expandHome(p: string): string {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/") || t.startsWith("~\\")) return join(homedir(), t.slice(2));
  return t;
}

/** OpenSSH's fingerprint format: `SHA256:` + unpadded base64 of the key's SHA-256. */
export function fingerprint(hostKey: Buffer): string {
  return "SHA256:" + createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "");
}

/**
 * Map an ssh2 failure onto a FailureKind, because the kind decides whether a retry loop is allowed
 * to run at all: retrying bad credentials every 10 seconds earns a fail2ban ban or an account
 * lockout, so `auth` must never be retried.
 */
export function classify(err: unknown): FailureKind {
  if (err instanceof TunnelError) return err.kind;
  const e = err as NodeJS.ErrnoException & { level?: string };
  const level = e?.level ?? "";
  const message = String(e?.message ?? "");
  if (level === "client-authentication" || /All configured authentication methods failed/i.test(message)) return "auth";
  if (/host (denied|key)/i.test(message)) return "hostkey";
  if (
    level === "client-timeout" ||
    e?.code === "ECONNREFUSED" || e?.code === "ENOTFOUND" || e?.code === "ETIMEDOUT" ||
    e?.code === "EHOSTUNREACH" || e?.code === "ENETUNREACH" || e?.code === "ECONNRESET"
  ) {
    return "network";
  }
  return "network";
}

/** Turn an unknown throw into a TunnelError, preserving an already-classified one. */
export function asTunnelError(err: unknown, prefix?: string): TunnelError {
  if (err instanceof TunnelError) return err;
  const message = (err as Error)?.message ?? String(err);
  return new TunnelError(prefix ? `${prefix}: ${message}` : message, classify(err));
}

export interface SshHooks {
  /** A fingerprint was learned (first connect) — persist it. */
  onHostKey?(fingerprint: string): void;
  /** The transport died while connected. The manager releases ports and decides about retrying. */
  onLost?(err: TunnelError): void;
}

export interface TestResult {
  ok: boolean;
  ms: number;
  banner?: string;
  error?: string;
  kind?: FailureKind;
  /** Set on a host-key mismatch, so the panel can offer "trust this key". */
  fingerprint?: string;
}

/** Read the private key, failing as `config` before any dial when it cannot be read. */
function readKey(def: SshConnDef): Buffer {
  const path = expandHome(def.keyPath ?? "");
  if (!path) throw new TunnelError("no private key path configured", "config");
  if (!isAbsolute(path)) throw new TunnelError(`private key path must be absolute: ${path}`, "config");
  try {
    return readFileSync(path);
  } catch (err) {
    throw new TunnelError(`cannot read private key ${path}: ${(err as Error).message}`, "config");
  }
}

/**
 * Build the ssh2 connect config for a definition.
 *
 * `hostVerifier` is where trust-on-first-use lives. ssh2 hands the raw host key when `hostHash` is
 * unset and uses a returned value when it is not undefined (verified in node_modules/ssh2 —
 * lib/client.js calls `verify(ret)` when the callback returns something), so a synchronous compare is
 * enough. Returning false makes ssh2 fail the handshake with "Host denied (verification failed)".
 */
function connectConfig(def: SshConnDef, onFingerprint: (fp: string) => void, mismatch: { value?: string }): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    host: def.host,
    port: def.port,
    username: def.username,
    readyTimeout: 15_000,
    // A tunnel idle long enough for a NAT or firewall to drop it silently is the failure this whole
    // feature exists to handle: without keepalive the transport looks alive forever while carrying
    // nothing, and the local port stays bound. 15s x 3 detects it in ~45s.
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    hostVerifier: (key: Buffer) => {
      const fp = fingerprint(key);
      if (!def.hostKey) {
        onFingerprint(fp);
        return true; // trust on first use
      }
      if (def.hostKey === fp) return true;
      mismatch.value = fp;
      return false;
    },
  };
  if (def.authType === "password") {
    cfg.password = def.password ?? "";
  } else {
    cfg.privateKey = readKey(def);
    if (def.passphrase) cfg.passphrase = def.passphrase;
  }
  return cfg;
}

/**
 * One ssh2 Client, shared by every forwarding rule that names this connection.
 *
 * Refcounted rather than one client per rule: "Start all" over the 14 rules on one host must dial
 * SSH once, not fourteen times — that is most of the memory difference against the tool this
 * replaces.
 */
export class SshConnection {
  state: ConnState = "idle";
  reason?: string;
  banner?: string;
  /** Rules currently using this connection. The last one to stop ends the client. */
  refs = 0;
  private client?: import("ssh2").Client;
  private connecting?: Promise<void>;

  constructor(private def: SshConnDef, private hooks: SshHooks = {}) {}

  /** Replace the definition (an edit); callers stop the rules and reconnect around this. */
  setDef(def: SshConnDef): void {
    this.def = def;
  }

  get connected(): boolean {
    return this.state === "connected" && !!this.client;
  }

  /** Dial and authenticate. Single-flight: N rules starting together share one handshake. */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.dial().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async dial(): Promise<void> {
    const { Client } = await loadSsh2();
    this.state = "connecting";
    this.reason = undefined;
    const mismatch: { value?: string } = {};
    const expected = this.def.hostKey;
    const cfg = connectConfig(this.def, (fp) => {
      this.hooks.onHostKey?.(fp);
    }, mismatch);

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      const fail = (err: Error) => {
        client.removeAllListeners();
        try { client.end(); } catch { /* never connected */ }
        if (mismatch.value) {
          reject(new TunnelError(
            `host key mismatch for ${this.def.host}: expected ${expected}, got ${mismatch.value}`,
            "hostkey",
            { expected, actual: mismatch.value },
          ));
          return;
        }
        reject(asTunnelError(err));
      };
      client.once("error", fail);
      client.once("banner", (text: string) => { this.banner = String(text).trim().slice(0, 200); });
      client.once("ready", () => {
        client.removeListener("error", fail);
        resolve();
      });
      try {
        client.connect(cfg as never);
      } catch (err) {
        fail(err as Error);
      }
    });

    this.client = client;
    this.state = "connected";

    // Past the handshake, a transport failure is a runtime event: the manager releases the ports of
    // every rule on this connection, then decides whether a retry is allowed.
    const lost = (err?: Error) => {
      if (this.client !== client) return; // a later connection already replaced this one
      this.client = undefined;
      this.state = "error";
      const te = err ? asTunnelError(err, "ssh connection lost") : new TunnelError("ssh connection closed", "network");
      this.reason = te.message;
      log("warn", "ssh connection lost", { host: this.def.host, err: te.message });
      this.hooks.onLost?.(te);
    };
    client.on("error", lost);
    client.on("close", () => lost());
    client.on("timeout", () => lost(new Error("keepalive timed out")));
  }

  /** Open one channel to `host:port` through this connection. */
  openChannel(host: string, port: number): Promise<Duplex> {
    const client = this.client;
    if (!client || this.state !== "connected") {
      return Promise.reject(new TunnelError("ssh connection is not established", "network"));
    }
    return new Promise((resolve, reject) => {
      client.forwardOut("127.0.0.1", 0, host, port, (err, channel) => {
        if (err) return reject(asTunnelError(err, `channel to ${host}:${port} failed`));
        resolve(channel as unknown as Duplex);
      });
    });
  }

  async end(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.state = "idle";
    this.reason = undefined;
    if (!client) return;
    client.removeAllListeners();
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 1500); // a wedged transport must not block a shutdown
      done.unref();
      client.once("close", () => { clearTimeout(done); resolve(); });
      try { client.end(); } catch { resolve(); }
    });
  }

  /**
   * Connect, authenticate and disconnect, on a THROWAWAY client.
   *
   * Never the live one: Test has to prove the credentials and the host key end to end, which is
   * exactly what a probe on an already-authenticated session cannot do.
   */
  static async test(def: SshConnDef): Promise<TestResult> {
    const t0 = Date.now();
    const probe = new SshConnection(def);
    try {
      await probe.connect();
      return { ok: true, ms: Date.now() - t0, banner: probe.banner };
    } catch (err) {
      const te = asTunnelError(err);
      return {
        ok: false,
        ms: Date.now() - t0,
        error: te.message,
        kind: te.kind,
        fingerprint: typeof te.detail?.actual === "string" ? te.detail.actual : undefined,
      };
    } finally {
      await probe.end();
    }
  }
}
