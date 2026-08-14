import type { Server } from "@modelcontextprotocol/server";
import type { Adapter } from "./adapters/types.js";
import type { ServerDef } from "./config.js";
import { isPageCacheStale, type PageCache } from "./paging.js";
import { log } from "./log.js";
import { invalidateMemoryCache } from "./mem.js";
import { clearCalls, forgetCallAlias, renameCalls } from "./calls.js";

export type Source = "config" | "managed";
export type Lifecycle = "starting" | "started" | "stopping" | "stopped" | "idle" | "error";
export type Health = "up" | "down" | "unknown";

/**
 * Is this MCP lazy — idle at boot, woken by its first request (see Registry.ensureStarted)?
 *
 * A proc MCP is lazy BY DEFAULT: its child process is the one thing here that costs real memory
 * (50-150MB each, versus ~0 for the in-process DB drivers and remote proxies), so an idle child is
 * money nobody asked to spend. Every other type defaults to start-at-boot — but `lazy: true` opts
 * ANY type in, which is what the panel's "Start automatically" checkbox writes.
 */
export function isLazy(def: ServerDef): boolean {
  const explicit = def.lazy;
  if (explicit !== undefined) return explicit !== false;
  return def.type === "proc";
}

/** How long a woken lazy proc stays up with no traffic before its child is reaped. 0 disables. */
const DEFAULT_IDLE_MS = 600_000;

/**
 * The SDK's server-change notifier — `createMcpHandler`'s `notify`. Each method publishes one change
 * kind onto the handler's internal event bus, and the handler's persistent `listenRouter` fans it out
 * to every active `subscriptions/listen` stream a 2026-07-28 client holds — how the gateway tells a
 * client its tool/resource list changed. Structurally typed so the registry need not import the SDK
 * type.
 */
export interface ServerNotifier {
  toolsChanged(): void;
  promptsChanged(): void;
  resourcesChanged(): void;
  resourceUpdated(uri: string): void;
}

/** One hosted MCP: its definition, adapter, live server (when started), and last health probe. */
export interface RegistryEntry {
  name: string;
  source: Source;
  def: ServerDef;
  adapter: Adapter;
  server?: Server;
  lifecycle: Lifecycle;
  startedAt?: string;
  error?: string; // lifecycle error (e.g. start failed)
  status: Health;
  latencyMs?: number;
  lastCheck?: string;
  lastError?: string; // health-check failure reason
  resPage?: PageCache; // lazy resource-list cache for the paging endpoint
  toolPage?: PageCache; // lazy tool-list cache for the paging endpoint
  promptPage?: PageCache; // lazy prompt-list cache for the paging endpoint
  /** Chain that serializes this entry's lifecycle operations (see Registry.enqueue). */
  op?: Promise<void>;
  /** Bumped by every start and stop, so a health probe can tell whether its result still describes
   *  the run it was issued against (see checkOne). */
  gen: number;
  /** The pending idle-reap timer for a woken lazy proc (see armIdle). Cleared on stop. */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** The SDK notifier for this entry's handler (set by the router when it builds the handler). A toggle
   *  fans a change event out to every active subscriptions/listen stream a 2026-07-28 client holds.
   *  Cleared on stop/restart. */
  notifier?: ServerNotifier;
}

/** A flat row for the dashboard / API, with a resolved display state. */
export interface StatusRow {
  name: string;
  source: Source;
  type: string;
  lifecycle: Lifecycle;
  /** stopped | starting | error | up | down | unknown (lifecycle overrides health unless started). */
  state: string;
  latencyMs?: number;
  lastCheck?: string;
  reason?: string;
  startedAt?: string;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns every hosted MCP: registration, lifecycle (start/stop/restart/rename/delete) and a
 * periodic health probe. The single source of truth the router and admin API read from.
 */
export class Registry {
  private entries = new Map<string, RegistryEntry>();
  private timer?: ReturnType<typeof setInterval>;
  /** Called when an entry's name is abandoned (rename's old name, or delete) so the router can close the
   *  createMcpHandler it cached under that name. Without it the handler leaks: the POST path that
   *  normally evicts a stale handler never runs for a name that no longer resolves to an entry. */
  private onEvict?: (name: string) => void;

  constructor(private intervalMs = 15000) {}

  register(name: string, source: Source, def: ServerDef, adapter: Adapter): RegistryEntry {
    if (this.entries.has(name)) throw new Error(`MCP already registered: ${name}`);
    // This name now belongs to this MCP, so any leftover rename redirect for it must go — otherwise
    // a new MCP reusing a freed name would have its calls filed under the MCP that vacated it.
    forgetCallAlias(name);
    const entry: RegistryEntry = {
      name,
      source,
      def,
      adapter,
      // A lazy proc's resting state is idle (spawnable on demand); everything else starts stopped.
      lifecycle: isLazy(def) ? "idle" : "stopped",
      status: "unknown",
      gen: 0,
    };
    this.entries.set(name, entry);
    return entry;
  }

  get(name: string): RegistryEntry | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  getServer(name: string): Server | undefined {
    return this.entries.get(name)?.server;
  }

  /** Remember the SDK notifier for this entry's handler (the router sets it on build; undefined clears
   *  it on stop/restart). A toggle publishes through it to reach modern subscriptions/listen clients. */
  setNotifier(name: string, notifier?: ServerNotifier): void {
    const e = this.entries.get(name);
    if (e) e.notifier = notifier;
  }

  /** Register the router's handler-eviction callback (see onEvict). Called once at wiring time. */
  setEvictor(fn: (name: string) => void): void {
    this.onEvict = fn;
  }

  /**
   * Tell every active subscriber (a 2026-07-28 client holding a subscriptions/listen stream) that this
   * MCP's tool list changed, so it re-lists. Routed through the SDK notifier → bus → listenRouter.
   */
  async notifyToolsChanged(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) return;
    e.notifier?.toolsChanged(); // fan out to every active subscriptions/listen stream (2026-07-28)
  }

  /** The resources counterpart: tell every active subscriber the resource list changed. */
  async notifyResourcesChanged(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) return;
    e.notifier?.resourcesChanged(); // fan out to every active subscriptions/listen stream (2026-07-28)
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  all(): RegistryEntry[] {
    return [...this.entries.values()];
  }

  private require(name: string): RegistryEntry {
    const e = this.entries.get(name);
    if (!e) throw new Error(`unknown MCP: ${name}`);
    return e;
  }

  /**
   * Run one lifecycle operation with every other one for the same entry queued behind it.
   *
   * Each of these is a check-then-act across an await — `start()` tested `!e.server` and only then
   * awaited `build()` — so two calls arriving together (a double-clicked button, two panel tabs, a
   * script hitting the API) both passed the test and both built. The loser's Server was dropped
   * without `close()`: a leaked pool for a DB adapter, and for a proc MCP a stray child process,
   * which is the exact orphan the in-process adapters were introduced to eliminate.
   */
  private enqueue<T>(e: RegistryEntry, fn: () => Promise<T>): Promise<T> {
    const run = (e.op ?? Promise.resolve()).then(fn);
    // Swallow on the chain only: the caller still sees the rejection through `run`, but one failed
    // operation must not wedge every later one behind it.
    e.op = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Build the server and mark started. Idempotent if already started. Throws on build failure. */
  async start(name: string): Promise<void> {
    const e = this.require(name);
    return this.enqueue(e, () => this.doStart(e));
  }

  /**
   * Wake an idle lazy proc and return its (now started) entry — what the MCP route calls when a
   * client reaches a proc the gateway never spawned. The wait is the contract: AI clients do not
   * retry gracefully, so the request that wakes the child is the request that gets served, bounded
   * by the adapter's own start timeout. Concurrent wakeups coalesce on the lifecycle queue into a
   * single spawn (the second caller's doStart finds a server and no-ops).
   */
  async ensureStarted(name: string): Promise<RegistryEntry> {
    const e = this.require(name);
    if (e.lifecycle === "idle") await this.start(name);
    return this.require(name);
  }

  /**
   * Note that this MCP just served traffic, pushing a lazy proc's idle-reap deadline back. Cheap
   * and safe on every type: it only arms a timer for an entry that is running AND lazy.
   */
  noteActivity(name: string): void {
    const e = this.entries.get(name);
    if (e && e.server) this.armIdle(e); // no-op unless lazy (the guard lives there, once)
  }

  /** (Re)arm the idle-reap timer for a RUNNING LAZY MCP. `idleMs: 0` opts out entirely.
   *  The isLazy guard is the whole point: this timer once armed for every started entry, silently
   *  stopping http MCPs and DB pools ten minutes after boot — the reaper is for lazy entries only. */
  private armIdle(e: RegistryEntry): void {
    if (!isLazy(e.def)) return;
    this.clearIdle(e);
    const requested = Number(e.def.idleMs);
    const ms = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_IDLE_MS;
    if (!ms) return;
    e.idleTimer = setTimeout(() => {
      e.idleTimer = undefined;
      log("info", "mcp idle — reaping child", { name: e.name, idleMs: ms });
      void this.stop(e.name).catch(() => { /* already stopping/stopped */ });
    }, ms);
    e.idleTimer.unref?.(); // a pending reap must never hold the process open on shutdown
  }

  private clearIdle(e: RegistryEntry): void {
    if (e.idleTimer) {
      clearTimeout(e.idleTimer);
      e.idleTimer = undefined;
    }
  }

  private async doStart(e: RegistryEntry): Promise<void> {
    const name = e.name;
    if (e.server) return; // already running
    e.gen++;
    e.lifecycle = "starting";
    e.error = undefined;
    try {
      e.server = await e.adapter.build();
      e.lifecycle = "started";
      e.startedAt = new Date().toISOString();
      e.resPage = undefined; // fresh page cache for the new server instance
      e.toolPage = undefined;
      e.promptPage = undefined;
      this.armIdle(e); // a woken lazy proc starts its idle-reap countdown now
      log("info", "mcp started", { name, type: e.adapter.type });
      invalidateMemoryCache();
    } catch (err) {
      e.lifecycle = "error";
      e.error = msg(err);
      log("error", "mcp start failed", { name, err: e.error });
      throw err;
    }
  }

  /** Close the underlying connection/process and free memory. Idempotent if already stopped. */
  async stop(name: string): Promise<void> {
    const e = this.require(name);
    return this.enqueue(e, () => this.doStop(e));
  }

  private async doStop(e: RegistryEntry): Promise<void> {
    const name = e.name;
    if (!e.server) return; // already stopped (or idle — no child to stop)
    this.clearIdle(e); // the reap that is firing, or a plain stop: either way the timer is done
    e.gen++;
    e.lifecycle = "stopping";
    log("info", "mcp stopping", { name });
    try {
      await e.adapter.close?.();
    } catch {
      /* best effort */
    }
    e.server = undefined;
    // A lazy proc's resting state is idle again — the next request is welcome to re-wake it. An
    // explicit stop lands here too: for a lazy entry there is no meaningful "off" short of disabling
    // or deleting it, which is what those switches are for.
    e.lifecycle = isLazy(e.def) ? "idle" : "stopped";
    e.status = "unknown";
    e.latencyMs = undefined;
    e.lastError = undefined;
    e.notifier = undefined; // the notifier belonged to the handler of the run that just ended
    e.resPage = undefined;
    e.toolPage = undefined;
    e.promptPage = undefined;
    log("info", "mcp stopped", { name });
    invalidateMemoryCache();
  }

  /** Replace an entry's def + adapter and restart it (used by config edit). */
  async updateDef(name: string, def: ServerDef, adapter: Adapter): Promise<void> {
    const e = this.require(name);
    // One queue slot for the whole swap, calling doStop/doStart directly: going through the public
    // stop()/start() from in here would wait on a queue this operation already holds.
    return this.enqueue(e, async () => {
      await this.doStop(e);
      // Carry the live toggles from the old adapter to the new one — `def` came from the form and
      // carries none, and the toggles live in the adapter's shared state, not the def. Without this,
      // a connection edit would silently re-enable every tool and every resource the user had turned off.
      const prevDisabled = e.adapter.toolToggle ? [...e.adapter.toolToggle.disabled] : undefined;
      const prevResources = e.adapter.resourceToggle ? e.adapter.resourceToggle.on : undefined;
      e.def = def;
      e.adapter = adapter;
      if (prevDisabled && adapter.toolToggle) adapter.toolToggle.disabled = new Set(prevDisabled);
      if (prevResources !== undefined && adapter.resourceToggle) adapter.resourceToggle.on = prevResources;
      await this.doStart(e);
      log("info", "mcp config updated", { name, type: def.type });
    });
  }

  async restart(name: string): Promise<void> {
    const e = this.require(name);
    return this.enqueue(e, async () => {
      await this.doStop(e);
      await this.doStart(e);
    });
  }

  async rename(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    const e = this.require(oldName);
    if (this.entries.has(newName)) throw new Error(`name already exists: ${newName}`);
    e.name = newName;
    this.entries.delete(oldName);
    this.entries.set(newName, e);
    this.onEvict?.(oldName); // the handler cached under the old name is now unreachable — close + free it
    // Carry the call history over and re-key the adapter, so a rename doesn't split one MCP's log
    // into a dead half and an empty half.
    await renameCalls(oldName, newName);
    e.adapter.rename?.(newName);
  }

  /** Remove a managed MCP. Config MCPs cannot be deleted (stop them instead). */
  async delete(name: string): Promise<void> {
    const e = this.require(name);
    if (e.source === "config") {
      throw new Error(`cannot delete config MCP '${name}' (stop it instead)`);
    }
    await this.stop(name);
    this.entries.delete(name);
    this.onEvict?.(name); // free the cached handler — the POST path won't, for a name that no longer exists
    await clearCalls(name); // nothing left to show it against
    log("info", "mcp deleted", { name });
  }

  // --- health probing (started entries only) ---

  startTimer(): void {
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkAll(): Promise<void> {
    this.sweepPageCaches();
    await Promise.all(this.all().map((e) => this.checkOne(e)));
  }

  /** Drop tool/resource/prompt page caches nobody has paged through lately, so a server that dumps
   *  thousands of resources in one go doesn't keep them resident forever. */
  sweepPageCaches(now = Date.now()): void {
    for (const e of this.entries.values()) {
      for (const field of ["resPage", "toolPage", "promptPage"] as const) {
        const cache = e[field];
        if (cache && isPageCacheStale(cache, now)) e[field] = undefined;
      }
    }
  }

  /** Root PIDs of every spawned child subtree (proc MCPs only). Empty when nothing was spawned —
   *  which is the signal that a memory measurement needs no process-tree walk at all. */
  childPids(): number[] {
    const out: number[] = [];
    for (const e of this.entries.values()) {
      const pids = e.adapter.pids?.() ?? [];
      for (const p of pids) if (p) out.push(p);
    }
    return out;
  }

  private async checkOne(e: RegistryEntry): Promise<void> {
    if (e.lifecycle !== "started") {
      e.status = "unknown";
      return;
    }
    if (!e.adapter.ping) {
      e.status = "unknown";
      e.lastCheck = new Date().toISOString();
      return;
    }
    e.lastCheck = new Date().toISOString();
    const t0 = Date.now();
    // The run this probe describes. A stop landing while the ping is in flight resets status and
    // lastError, and writing a late result over that reset left a stopped MCP showing a connection
    // error — permanently, since checkOne only clears `status` for a non-started entry.
    const gen = e.gen;
    try {
      await e.adapter.ping();
      if (e.gen !== gen) return;
      e.status = "up";
      e.latencyMs = Date.now() - t0;
      e.lastError = undefined;
    } catch (err) {
      if (e.gen !== gen) return;
      e.status = "down";
      e.latencyMs = undefined;
      e.lastError = msg(err);
      log("warn", "health check failed", { name: e.name, err: e.lastError });
    }
  }

  status(): StatusRow[] {
    return this.all().map((e) => ({
      name: e.name,
      source: e.source,
      type: e.adapter.type,
      lifecycle: e.lifecycle,
      state: e.lifecycle === "started" ? e.status : e.lifecycle,
      latencyMs: e.latencyMs,
      lastCheck: e.lastCheck,
      reason: e.lifecycle === "error" ? e.error : e.lastError,
      startedAt: e.startedAt,
    }));
  }

  /** Stop the timer and close every entry. Used on shutdown. */
  async closeAll(): Promise<void> {
    this.stopTimer();
    await Promise.all(this.all().map((e) => this.stop(e.name)));
  }
}
