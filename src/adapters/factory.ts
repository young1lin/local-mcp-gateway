import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "@modelcontextprotocol/server";
import type { Adapter } from "./types.js";
import { resolveDef, type ServerDef } from "../config.js";
import { dataDir } from "../datadir.js";
import { ProcAdapter } from "./proc.js";
import { HttpAdapter } from "./http.js";
import { RestAdapter } from "./rest.js";
import { makeEchoAdapter } from "./echo.js";
import { MysqlAdapter } from "./mysql.js";
import { RedisAdapter } from "./redis.js";
import { PgAdapter } from "./pg.js";
import { MongoAdapter } from "./mongo.js";

/** Build an Adapter from an already-`${ENV}`-resolved def. The unit this module registers. */
export type AdapterFactory = (def: ServerDef, name?: string) => Adapter;

const factories = new Map<string, AdapterFactory>();

/**
 * Register an adapter type. The built-ins register below at module load; this export is the same
 * door for anything else — a plugin entry, a test. Duplicate types are refused rather than
 * overwritten: a silent overwrite would let a late load shadow a built-in and change what an
 * existing config silently means.
 */
export function registerAdapterFactory(type: string, factory: AdapterFactory): void {
  if (factories.has(type)) throw new Error(`adapter type already registered: ${type}`);
  factories.set(type, factory);
}

/*
 * Map a config/managed ServerDef to its Adapter. Single source of truth for boot + admin add.
 *
 * `${ENV_VAR}` references are expanded in makeAdapter() rather than at config load, so the
 * registry (and the admin panel, and anything persisted back to managed.json) only ever sees the
 * reference — the plaintext credential exists just inside the adapter.
 *
 * Built-in families (registered below):
 * - **Direct** (`mysql`/`redis`/`pg`/`mongo`): in-process DB drivers, imported on first use. No child
 *   process, so nothing can orphan and memory is tiny (shared with the gateway).
 * - **proc**: spawn an arbitrary launch command (`npx -y @pkg`, `uvx ...`, `python -m ...`) and
 *   proxy MCP over stdio. Kept for any MCP without a direct adapter; tree-killed on close.
 *
 * A type that is not registered can still name a module to load at start — see ExternalAdapter.
 *
 * `name` is the registry name; adapters carry it only so tool calls can be filed under the right MCP
 * in the call log (src/calls.ts).
 */

/** Turn a config `adapter` spec into an importable target: a bare name stays bare (node resolves
 *  it through the gateway's own node_modules), a `./relative` path resolves against the data dir
 *  (next to gateway.config.json, where user files live), and anything path-shaped becomes a
 *  file URL. */
function adapterImportTarget(spec: string): string {
  if (/^([a-zA-Z]:[\\/]|file:\/\/|\/)/.test(spec)) {
    return spec.startsWith("file://") ? spec : pathToFileURL(spec).href;
  }
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return pathToFileURL(join(dataDir(), spec)).href;
  }
  return spec;
}

/**
 * A third-party adapter, loaded on first build: `"type": "mine", "adapter": "my-lmg-adapter"` in
 * config (or `"./my-adapter.mjs"`, resolved against the data dir). The module must export
 * `createAdapter(def, name)` — named or default — returning an {@link Adapter}.
 *
 * The load happens in build(), not in makeAdapter(), because makeAdapter is synchronous: it runs
 * at config load and panel-add time, where an await is not available. The cost is that a broken
 * package surfaces as a start error rather than a config error — which is also where a built-in
 * adapter's driver failures surface, so failures land where the log already looks.
 *
 * Every optional Adapter member is delegated after build, so a third-party type behaves exactly
 * like a built-in: same registry lifecycle, same call log, same panel.
 */
export class ExternalAdapter implements Adapter {
  readonly type: string;
  private inner?: Adapter;
  private builtServer?: Server;

  constructor(
    private spec: string,
    private def: ServerDef,
    private name?: string,
  ) {
    this.type = String(def.type);
  }

  async build(): Promise<Server> {
    const mod = (await import(adapterImportTarget(this.spec))) as {
      createAdapter?: unknown;
      default?: unknown;
    };
    const raw: unknown =
      typeof mod.createAdapter === "function"
        ? mod.createAdapter
        : typeof mod.default === "function"
          ? mod.default
          : undefined;
    if (typeof raw !== "function") {
      throw new Error(`${this.spec} does not export createAdapter(def, name) — named or default`);
    }
    const create = raw as (def: ServerDef, name?: string) => unknown;
    const made = create(this.def, this.name);
    if (!made || typeof (made as { build?: unknown }).build !== "function") {
      throw new Error(`${this.spec}'s createAdapter must return an Adapter (one with a build() method)`);
    }
    this.inner = made as Adapter;
    this.builtServer = await this.inner.build();
    return this.builtServer;
  }

  /** Fresh server per request (see Adapter.makeServer). When the inner adapter has none, the
   *  built server is reused — the same fallback the router applies to built-ins without it. */
  makeServer(): Server {
    if (!this.inner || !this.builtServer) throw new Error("not started");
    return this.inner.makeServer ? this.inner.makeServer() : this.builtServer;
  }

  /** Ping exists only when the inner adapter declares one. A custom adapter wrapping a real
   *  database should be probed like the built-ins; one wrapping a metered remote must stay
   *  "unknown" rather than be polled every 15s (the AGENTS.md http/rest rule). The getter keeps
   *  presence dynamic — `registry.checkOne` reads `adapter.ping` fresh each probe — instead of the
   *  old always-succeed method that lit http-shaped externals green with a fake latency. */
  get ping(): (() => Promise<void>) | undefined {
    const inner = this.inner;
    if (!inner?.ping) return undefined;
    return () => inner.ping!();
  }

  async close(): Promise<void> {
    await this.inner?.close?.();
    this.inner = undefined;
    this.builtServer = undefined;
  }

  logs(): string {
    return this.inner?.logs?.() ?? "";
  }

  pids(): number[] {
    return this.inner?.pids?.() ?? [];
  }

  rename(name: string): void {
    this.name = name;
    this.inner?.rename?.(name);
  }

  get toolToggle() {
    return this.inner?.toolToggle;
  }

  get resourceToggle() {
    return this.inner?.resourceToggle;
  }
}

/** Build the Adapter for a def: a registered type, or a third-party module it names. */
export function makeAdapter(rawDef: ServerDef, name?: string): Adapter {
  const def = resolveDef(rawDef);
  const factory = factories.get(def.type);
  if (factory) return factory(def, name);
  if (typeof def.adapter === "string" && def.adapter) {
    return new ExternalAdapter(def.adapter, def, name);
  }
  throw new Error(
    `Unknown adapter type: ${def.type as string} (built-in: ${[...factories.keys()].sort().join(" | ")}; ` +
      `or set "adapter": "<package or ./file.mjs>" to load a third-party one)`,
  );
}

// The built-ins. Registered once at module load; makeAdapter above is the only reader.
registerAdapterFactory("mysql", (def, name) => new MysqlAdapter(def, name));
registerAdapterFactory("redis", (def, name) => new RedisAdapter(def, name));
registerAdapterFactory("pg", (def, name) => new PgAdapter(def, name));
registerAdapterFactory("mongo", (def, name) => new MongoAdapter(def, name));
registerAdapterFactory("proc", (def, name) =>
  new ProcAdapter({
    name,
    command: def.command as string,
    env: def.env as Record<string, string> | undefined,
    cwd: def.cwd as string | undefined,
    description: def.description as string | undefined,
    exposeResources: def.exposeResources as boolean | undefined,
    exposePrompts: def.exposePrompts as boolean | undefined,
    timeoutMs: def.timeoutMs as number | undefined,
  }),
);
registerAdapterFactory("rest", (def, name) => new RestAdapter(def, name));
registerAdapterFactory("http", (def, name) =>
  new HttpAdapter({
    name,
    url: def.url as string,
    headers: def.headers as Record<string, string> | undefined,
    proxy: def.proxy as string | undefined,
    description: def.description as string | undefined,
    exposeResources: def.exposeResources as boolean | undefined,
    exposePrompts: def.exposePrompts as boolean | undefined,
  }),
);
// Named so echo tool calls are logged like every other adapter's (see makeEchoAdapter).
registerAdapterFactory("echo", (_def, name) => makeEchoAdapter(name));
