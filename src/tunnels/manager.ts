import type { Duplex } from "node:stream";
import { log } from "../log.js";
import { Forward } from "./forward.js";
import { portOwner, type PortOwner } from "./port.js";
import { asTunnelError, SshConnection } from "./ssh.js";
import type { ConnInput, RuleInput, TunnelStore } from "./store.js";
import {
  isRetryable, TunnelError,
  type ConnRow, type RuleDef, type RuleRow, type RuleState, type SshConnDef,
} from "./types.js";

/** Cap on reconnect backoff. A sustained outage backs off toward this interval rather than dialing
 *  every `reconnectInterval` seconds forever (which, against a host that is truly down, is thrash). */
const RECONNECT_CAP_MS = 5 * 60 * 1000;
/** Clamp the exponent before the cap does, so 2 ** retries can't overflow on a very long outage. */
const RECONNECT_MAX_EXP = 8;

/** What the manager needs from an SSH connection — an interface so tests can inject a fake. */
export interface SshLike {
  state: "idle" | "connecting" | "connected" | "error";
  reason?: string;
  banner?: string;
  refs: number;
  readonly connected: boolean;
  setDef(def: SshConnDef): void;
  connect(): Promise<void>;
  openChannel(host: string, port: number): Promise<Duplex>;
  end(): Promise<void>;
}

export interface SshHooksIn {
  onHostKey?(fingerprint: string): void;
  onLost?(err: TunnelError): void;
}

/** The slice of the MCP registry the tunnel subsystem reads. Display and guard rail only. */
export interface McpView {
  has(name: string): boolean;
  /** Display state ("up" | "down" | "stopped" | "error" | …), or undefined when unknown. */
  stateOf(name: string): string | undefined;
  /** True when the MCP is actually running — what the stop guard asks about. */
  isStarted(name: string): boolean;
  /** ISO timestamp of the MCP's current run, for the stale-pool notice. */
  startedAt(name: string): string | undefined;
}

export interface ManagerDeps {
  mcps?: McpView;
  /** Injected in tests so the whole lifecycle runs with no SSH server. */
  makeConnection?: (def: SshConnDef, hooks: SshHooksIn) => SshLike;
}

/** Thrown when stopping or deleting a rule that started MCPs are using. The panel confirms, then forces. */
export class DependentsError extends Error {
  constructor(readonly dependents: string[]) {
    super(`in use by: ${dependents.join(", ")}`);
    this.name = "DependentsError";
  }
}

interface RuleRuntime {
  state: RuleState;
  reason?: string;
  forward?: Forward;
  startedAt?: string;
  reconnectedAt?: string;
  portOwner?: PortOwner;
  retry?: ReturnType<typeof setTimeout>;
  /** Serializes this rule's lifecycle operations (the Registry.enqueue pattern). */
  op?: Promise<void>;
  /** True between a transport loss and the next successful start, so it reports as a reconnect. */
  lost?: boolean;
  /** Consecutive failed reconnect attempts since the last successful connect — drives backoff. */
  retries?: number;
  /** The connection id this rule currently holds a reference on. */
  holding?: string;
}

export interface OpResult {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
}

/**
 * Owns the live state of every SSH connection and forwarding rule.
 *
 * Two invariants drive the shape of this class:
 *
 *  - A local port is bound only while its tunnel can carry traffic. Every path that leaves the
 *    working state closes the Forward (which destroys sockets and verifies the release) BEFORE it
 *    reports a new state.
 *  - One SSH client per connection, refcounted. "Start all" over 14 rules on one host dials once.
 */
export class TunnelManager {
  private runtimes = new Map<string, RuleRuntime>();
  private conns = new Map<string, SshLike>();
  /** Fingerprint a connection presented when it failed verification, so it can be trusted later. */
  private mismatches = new Map<string, string>();

  constructor(private store: TunnelStore, private deps: ManagerDeps = {}) {}

  // --- runtime bookkeeping ----------------------------------------------------------------------

  private rt(id: string): RuleRuntime {
    let r = this.runtimes.get(id);
    if (!r) {
      r = { state: "stopped" };
      this.runtimes.set(id, r);
    }
    return r;
  }

  /**
   * Run one lifecycle operation with every other one for the same rule queued behind it.
   *
   * Same reasoning as Registry.enqueue: each of these is a check-then-act across an await, so two
   * calls arriving together (a double-clicked button, two panel tabs, a reconnect timer firing into a
   * user's stop) both pass the test and both act — leaking a listener, or binding a port nobody
   * tracks.
   */
  private enqueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const rt = this.rt(id);
    const run = (rt.op ?? Promise.resolve()).then(fn);
    rt.op = run.then(() => undefined, () => undefined);
    return run;
  }

  private clearRetry(rt: RuleRuntime): void {
    if (rt.retry) {
      clearTimeout(rt.retry);
      rt.retry = undefined;
    }
  }

  // --- connections ------------------------------------------------------------------------------

  private makeConn(def: SshConnDef): SshLike {
    const hooks: SshHooksIn = {
      onHostKey: (fp) => {
        try {
          this.store.setHostKey(def.id, fp);
        } catch (err) {
          log("warn", "could not persist host key", { connection: def.name, err: (err as Error).message });
        }
      },
      onLost: (err) => void this.onConnectionLost(def.id, err),
    };
    if (this.deps.makeConnection) return this.deps.makeConnection(def, hooks);
    return new SshConnection(def, hooks) as unknown as SshLike;
  }

  private conn(def: SshConnDef): SshLike {
    let c = this.conns.get(def.id);
    if (!c) {
      c = this.makeConn(def);
      this.conns.set(def.id, c);
    } else {
      c.setDef(def);
    }
    return c;
  }

  /** Connect (or reuse) the connection and take a reference for this rule. */
  private async acquire(def: SshConnDef, rt: RuleRuntime): Promise<SshLike> {
    const c = this.conn(def);
    try {
      await c.connect();
    } catch (err) {
      const te = asTunnelError(err);
      if (te.kind === "hostkey" && typeof te.detail?.actual === "string") {
        this.mismatches.set(def.id, te.detail.actual);
      }
      throw te;
    }
    // A rule holds at most one reference, however many times it is started.
    if (rt.holding !== def.id) {
      c.refs++;
      rt.holding = def.id;
    }
    return c;
  }

  /** Drop this rule's reference; the last one out ends the client and frees its session memory. */
  private async release(rt: RuleRuntime): Promise<void> {
    const id = rt.holding;
    if (!id) return;
    rt.holding = undefined;
    const c = this.conns.get(id);
    if (!c) return;
    c.refs = Math.max(0, c.refs - 1);
    if (c.refs === 0) {
      this.conns.delete(id);
      await c.end();
    }
  }

  /** Close the forward (releasing the port) and drop the SSH reference. */
  private async teardown(rt: RuleRuntime): Promise<void> {
    const fwd = rt.forward;
    rt.forward = undefined;
    if (fwd) await fwd.close();
    await this.release(rt);
  }

  /**
   * A transport died under one or more running rules.
   *
   * Ports come down first, always: a rule reported "reconnecting" while still holding its port is the
   * exact confusion this feature was built to remove.
   */
  private async onConnectionLost(connId: string, err: TunnelError): Promise<void> {
    for (const rule of this.store.rulesForConnection(connId)) {
      const rt = this.runtimes.get(rule.id);
      if (!rt || (rt.state !== "up" && rt.state !== "starting")) continue;
      void this.enqueue(rule.id, async () => {
        if (rt.state !== "up" && rt.state !== "starting") return;
        await this.teardown(rt);
        rt.lost = true;
        rt.reason = err.message;
        if (rule.autoReconnect && isRetryable(err.kind)) {
          rt.state = "reconnecting";
          this.scheduleRetry(rule);
        } else {
          // An auth or host-key failure must not be retried: hammering the server every 10s earns a
          // fail2ban ban, and a changed host key needs a human.
          rt.state = "error";
        }
        log("warn", "tunnel down", { rule: rule.name, state: rt.state, reason: rt.reason });
      });
    }
  }

  private scheduleRetry(rule: RuleDef): void {
    const rt = this.rt(rule.id);
    this.clearRetry(rt);
    rt.retries = (rt.retries ?? 0) + 1;
    const base = Math.max(1, rule.reconnectInterval) * 1000;
    // Exponential backoff capped at RECONNECT_CAP_MS: a sustained outage dials less and less often
    // instead of every `interval` seconds forever. ±20% jitter keeps rules on one host from retrying
    // in lockstep. (Auth/host-key never reach here; port failures no longer do either — see
    // isRetryable. Per-connection coalescing of sibling retries is a future improvement; the SSH
    // single-flight already collapses near-simultaneous dials onto one connection.)
    const exp = Math.min(RECONNECT_CAP_MS, base * 2 ** Math.min(rt.retries - 1, RECONNECT_MAX_EXP));
    const delay = Math.round(exp * (0.8 + Math.random() * 0.4));
    rt.retry = setTimeout(() => {
      rt.retry = undefined;
      void this.startRule(rule.id).catch(() => { /* state and reason are already recorded */ });
    }, delay);
    rt.retry.unref(); // a pending retry must never hold the process alive at shutdown
  }

  // --- rule lifecycle ---------------------------------------------------------------------------

  startRule(id: string): Promise<void> {
    const rule = this.store.rule(id);
    if (!rule) return Promise.reject(new Error(`unknown rule: ${id}`));
    return this.enqueue(id, () => this.doStart(rule));
  }

  private async doStart(rule: RuleDef, retriedOwnPort = false): Promise<void> {
    const rt = this.rt(rule.id);
    this.clearRetry(rt);
    if (rt.forward?.listening) {
      rt.state = "up";
      return;
    }
    const conn = this.store.connection(rule.connectionId);
    if (!conn) {
      rt.state = "error";
      rt.reason = `unknown SSH connection: ${rule.connectionId || "(none)"}`;
      throw new TunnelError(rt.reason, "config");
    }
    rt.state = "starting";
    rt.reason = undefined;
    rt.portOwner = undefined;
    try {
      const ssh = await this.acquire(conn, rt);
      const fwd = new Forward(
        { localPort: rule.localPort, targetHost: rule.targetHost, targetPort: rule.targetPort },
        (host, port) => ssh.openChannel(host, port),
      );
      await fwd.listen();
      rt.forward = fwd;
      rt.state = "up";
      rt.retries = 0; // a successful connect resets the backoff for the next outage
      const now = new Date().toISOString();
      if (rt.lost) {
        rt.reconnectedAt = now;
        rt.lost = false;
      } else {
        rt.startedAt = now;
      }
      this.store.setEnabled(rule.id, true);
      log("info", "tunnel up", { rule: rule.name, local: rule.localPort, target: `${rule.targetHost}:${rule.targetPort}` });
    } catch (err) {
      const te = asTunnelError(err);
      await this.teardown(rt);
      if (te.kind === "port") {
        const owner = await portOwner(rule.localPort);
        // Our own stale listener is the gateway's problem to clean up, not the user's: close it and
        // try once more. Anything else is reported with the holder named, so the panel can offer
        // Force free rather than showing a bare EADDRINUSE.
        if (owner && owner.pid === process.pid && !retriedOwnPort) {
          log("warn", "reclaiming a port held by our own stale listener", { port: rule.localPort });
          await this.closeStrayOn(rule.localPort, rule.id);
          return this.doStart(rule, true);
        }
        rt.portOwner = owner ?? undefined;
      }
      rt.state = "error";
      rt.reason = te.kind === "port" && rt.portOwner
        ? `local port ${rule.localPort} is held by pid ${rt.portOwner.pid} (${rt.portOwner.name})`
        : te.message;
      if (rule.autoReconnect && isRetryable(te.kind)) {
        rt.state = "reconnecting";
        this.scheduleRetry(rule);
      }
      log("warn", "tunnel start failed", { rule: rule.name, kind: te.kind, reason: rt.reason });
      throw new TunnelError(rt.reason, te.kind, te.detail);
    }
  }

  /** Close any forward of ours that still holds `port` (state desync recovery). */
  private async closeStrayOn(port: number, exceptRuleId: string): Promise<void> {
    for (const rule of this.store.rules()) {
      if (rule.id === exceptRuleId || rule.localPort !== port) continue;
      const rt = this.runtimes.get(rule.id);
      if (!rt?.forward) continue;
      await this.teardown(rt);
      rt.state = "stopped";
    }
  }

  /**
   * Stop a rule. `persist: false` keeps its `enabled` flag, which is how shutdown leaves the set of
   * rules that should come back up on the next boot.
   */
  stopRule(id: string, opts: { persist?: boolean; force?: boolean } = {}): Promise<void> {
    const rule = this.store.rule(id);
    if (!rule) return Promise.reject(new Error(`unknown rule: ${id}`));
    const dependents = opts.force ? [] : this.dependentsOf(id);
    if (dependents.length) return Promise.reject(new DependentsError(dependents));
    return this.enqueue(id, async () => {
      const rt = this.rt(id);
      this.clearRetry(rt);
      await this.teardown(rt);
      rt.state = "stopped";
      rt.reason = undefined;
      rt.lost = false;
      rt.retries = 0;
      rt.startedAt = undefined;
      rt.reconnectedAt = undefined;
      rt.portOwner = undefined;
      if (opts.persist !== false) this.store.setEnabled(id, false);
      log("info", "tunnel stopped", { rule: rule.name });
    });
  }

  /** Start every rule marked enabled. Never throws: one bad rule must not hold up the gateway. */
  async startEnabled(): Promise<OpResult[]> {
    const rules = this.store.rules().filter((r) => r.enabled);
    if (!rules.length) return [];
    return this.runMany(rules, (r) => this.startRule(r.id));
  }

  async startAll(): Promise<OpResult[]> {
    return this.runMany(this.store.rules(), (r) => this.startRule(r.id));
  }

  async stopAll(force = false): Promise<OpResult[]> {
    const running = this.store.rules().filter((r) => {
      const s = this.runtimes.get(r.id)?.state;
      return s === "up" || s === "starting" || s === "reconnecting" || s === "error";
    });
    if (!force) {
      const blocked = new Set<string>();
      for (const r of running) for (const d of this.dependentsOf(r.id)) blocked.add(d);
      if (blocked.size) throw new DependentsError([...blocked]);
    }
    return this.runMany(running, (r) => this.stopRule(r.id, { force: true }));
  }

  /**
   * Run an operation over many rules, grouped so rules sharing a connection are serialized behind
   * one dial rather than racing 14 handshakes at the same host.
   */
  private async runMany(rules: RuleDef[], op: (r: RuleDef) => Promise<void>): Promise<OpResult[]> {
    const byConn = new Map<string, RuleDef[]>();
    for (const r of rules) {
      const list = byConn.get(r.connectionId);
      if (list) list.push(r);
      else byConn.set(r.connectionId, [r]);
    }
    const results: OpResult[] = [];
    await Promise.all(
      [...byConn.values()].map(async (group) => {
        for (const rule of group) {
          try {
            await op(rule);
            results.push({ id: rule.id, name: rule.name, ok: true });
          } catch (err) {
            results.push({ id: rule.id, name: rule.name, ok: false, error: (err as Error).message });
          }
        }
      }),
    );
    return results;
  }

  // --- edits and deletes ------------------------------------------------------------------------

  /** Save a rule edit, restarting it when it was running. */
  async applyRuleUpdate(id: string, input: RuleInput): Promise<RuleDef> {
    const wasRunning = this.isActive(id);
    if (wasRunning) await this.stopRule(id, { persist: false, force: true });
    const def = this.store.updateRule(id, input);
    if (wasRunning) await this.startRule(id);
    return def;
  }

  /**
   * Save a connection edit: stop its rules, replace the client, restart the ones that were running.
   * Only those — a rule the user had deliberately stopped must not come up because a neighbour was
   * edited.
   */
  async applyConnectionUpdate(id: string, input: ConnInput): Promise<SshConnDef> {
    const wasRunning = this.store.rulesForConnection(id).filter((r) => this.isActive(r.id));
    for (const r of wasRunning) await this.stopRule(r.id, { persist: false, force: true });
    const existing = this.conns.get(id);
    if (existing) {
      this.conns.delete(id);
      await existing.end();
    }
    this.mismatches.delete(id);
    const def = this.store.updateConnection(id, input);
    for (const r of wasRunning) {
      try {
        await this.startRule(r.id);
      } catch {
        /* the rule holds its own error state */
      }
    }
    return def;
  }

  async deleteRule(id: string, force = false): Promise<void> {
    if (!this.store.rule(id)) throw new Error(`unknown rule: ${id}`);
    const dependents = force ? [] : this.dependentsOf(id);
    if (dependents.length) throw new DependentsError(dependents);
    await this.stopRule(id, { persist: false, force: true });
    this.runtimes.delete(id);
    this.store.removeRule(id);
  }

  async deleteConnection(id: string): Promise<void> {
    // The store refuses while rules reference it, naming them — that message is the useful one.
    this.store.removeConnection(id);
    const c = this.conns.get(id);
    if (c) {
      this.conns.delete(id);
      await c.end();
    }
    this.mismatches.delete(id);
  }

  /** Dial a throwaway client to prove credentials and host key end to end. */
  async testConnection(id: string) {
    const def = this.store.connection(id);
    if (!def) throw new Error(`unknown SSH connection: ${id}`);
    const res = await SshConnection.test(def);
    if (!res.ok && res.kind === "hostkey" && res.fingerprint) this.mismatches.set(id, res.fingerprint);
    if (res.ok && !def.hostKey) {
      // The throwaway client learned the fingerprint through the same hook path; nothing to do here,
      // but re-read so the caller sees the stored value.
      return { ...res, hostKey: this.store.connection(id)?.hostKey };
    }
    return res;
  }

  /**
   * Accept the fingerprint a connection presented. With a recorded mismatch we store exactly that
   * key; otherwise we clear the stored one so the next connect learns it (trust on first use).
   */
  trustHostKey(id: string): string | undefined {
    const def = this.store.connection(id);
    if (!def) throw new Error(`unknown SSH connection: ${id}`);
    const presented = this.mismatches.get(id);
    if (presented) {
      this.store.setHostKey(id, presented);
      this.mismatches.delete(id);
      this.conns.get(id)?.setDef(this.store.connection(id)!);
      return presented;
    }
    this.store.updateConnection(id, { ...def, hostKey: undefined } as ConnInput);
    return undefined;
  }

  // --- MCP linkage (display + guard rail only) --------------------------------------------------

  /** Started MCPs that this rule declares it serves. */
  dependentsOf(ruleId: string): string[] {
    const rule = this.store.rule(ruleId);
    const view = this.deps.mcps;
    if (!rule || !view) return [];
    return rule.mcps.filter((name) => view.isStarted(name));
  }

  /** An MCP was renamed: carry every link over so it does not silently point at a dead name. */
  renameMcp(from: string, to: string): void {
    this.store.renameMcp(from, to);
  }

  /** An MCP was deleted: no rule may go on claiming to serve it. */
  forgetMcp(name: string): void {
    this.store.forgetMcp(name);
  }

  /** Tunnels declaring they serve `mcp`, for the MCP detail page. */
  tunnelsForMcp(mcp: string): Array<{
    id: string; name: string; state: RuleState; localPort: number; targetHost: string; targetPort: number;
    reason?: string; reconnectedAt?: string; stalePool: boolean;
  }> {
    const startedAt = this.deps.mcps?.startedAt(mcp);
    return this.store.rules()
      .filter((r) => r.mcps.includes(mcp))
      .map((r) => {
        const rt = this.rt(r.id);
        return {
          id: r.id,
          name: r.name,
          state: rt.state,
          localPort: r.localPort,
          targetHost: r.targetHost,
          targetPort: r.targetPort,
          reason: rt.reason,
          reconnectedAt: rt.reconnectedAt,
          // A reconnect after the MCP started means its pool may still hold sockets of the old SSH
          // session. Information only — nothing here restarts an MCP.
          stalePool: !!(rt.reconnectedAt && startedAt && rt.reconnectedAt > startedAt),
        };
      });
  }

  // --- reporting --------------------------------------------------------------------------------

  isActive(id: string): boolean {
    const s = this.runtimes.get(id)?.state;
    return s === "up" || s === "starting" || s === "reconnecting";
  }

  rows(): { connections: ConnRow[]; rules: RuleRow[] } {
    const view = this.deps.mcps;
    const rules: RuleRow[] = this.store.rules().map((r) => {
      const rt = this.rt(r.id);
      const stats = rt.forward?.stats();
      const conn = this.store.connection(r.connectionId);
      return {
        ...r,
        state: rt.state,
        reason: rt.reason ?? stats?.lastError,
        connectionName: conn?.name ?? "(unknown)",
        startedAt: rt.startedAt,
        reconnectedAt: rt.reconnectedAt,
        sockets: stats?.sockets ?? 0,
        bytesIn: stats?.bytesIn ?? 0,
        bytesOut: stats?.bytesOut ?? 0,
        channelFailures: stats?.channelFailures ?? 0,
        portOwner: rt.portOwner,
        mcpRows: r.mcps.map((name) => ({
          name,
          state: view?.stateOf(name) ?? "unknown",
          known: view?.has(name) ?? false,
        })),
      };
    });
    const connections: ConnRow[] = this.store.connections().map((c) => {
      const live = this.conns.get(c.id);
      const mine = rules.filter((r) => r.connectionId === c.id);
      return {
        id: c.id,
        name: c.name,
        host: c.host,
        port: c.port,
        username: c.username,
        authType: c.authType,
        state: live?.state ?? "idle",
        reason: live?.reason,
        hostKey: c.hostKey,
        ruleCount: mine.length,
        activeRules: mine.filter((r) => r.state === "up").length,
      };
    });
    return { connections, rules };
  }

  /**
   * Shut everything down without touching `enabled`, so the next boot restores the same set.
   * Must finish inside index.ts's 3s force-exit budget: closes are local and the SSH end() has its
   * own 1.5s cap.
   */
  async closeAll(): Promise<void> {
    for (const rt of this.runtimes.values()) this.clearRetry(rt);
    await Promise.all(
      this.store.rules().map((r) =>
        this.stopRule(r.id, { persist: false, force: true }).catch(() => { /* best effort */ }),
      ),
    );
    const live = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(live.map((c) => c.end().catch(() => { /* best effort */ })));
  }
}
