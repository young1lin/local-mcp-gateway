import type { Server } from "@modelcontextprotocol/server";
import type { Adapter } from "./types.js";
import type { ServerDef } from "../config.js";
import { makeToolServer, type ToolDef } from "./tool-server.js";
import { clampRowLimit, DEFAULT_ROW_LIMIT } from "./sql.js";
import type { ResourceProvider } from "./resources.js";

/**
 * A flag that may arrive as a JSON boolean or as a string: the panel posts form values, so
 * `"readonly": "true"` and `"readonly": true` both have to mean the same thing.
 */
export function defBool(def: ServerDef, key: string): boolean {
  const v = def[key];
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * A connection opened on first use and shared from then on.
 *
 * The single-flight promise is the point: two concurrent first requests must share one connection
 * rather than race two into existence and leak one. A failed attempt clears itself, so the next
 * request tries again instead of being handed the same rejected promise forever.
 */
export class Lazy<T> {
  private value?: T;
  private pending?: Promise<T>;

  constructor(private readonly open: () => Promise<T>) {}

  get(): Promise<T> {
    if (this.value) return Promise.resolve(this.value);
    if (!this.pending) {
      this.pending = this.open()
        .then((v) => { this.value = v; return v; })
        .catch((err) => { this.pending = undefined; throw err; });
    }
    return this.pending;
  }

  /** Forget the connection and hand it back, so the caller can close it in its own way. */
  take(): T | undefined {
    const value = this.value;
    this.value = undefined;
    this.pending = undefined;
    return value;
  }
}

/**
 * What the three in-process DB adapters (mysql / redis / pg) have in common: a config definition, the
 * MCP name their calls are logged under, and one MCP Server per request built from a fixed tool set.
 * A subclass supplies only what is driver-specific — its tools, where it points, how to open and
 * close a connection, what a tool call does, and how to probe it.
 *
 * None of them spawn a process, so there is nothing to orphan and no per-MCP process memory; the
 * driver itself is imported on first use, so a gateway with no Postgres MCP never loads `pg`.
 */
export abstract class DirectAdapter implements Adapter {
  abstract readonly type: string;
  protected abstract readonly tools: ToolDef[];
  /** Where this endpoint points — "app @ localhost:3306". Shown to clients; never a password. */
  protected abstract get target(): string;
  /** Open the connection if it isn't open yet. */
  protected abstract open(): Promise<unknown>;
  /** Run one tool call and return any JSON-serializable value. */
  protected abstract call(tool: string, args: Record<string, unknown> | undefined): Promise<unknown>;

  constructor(protected readonly def: ServerDef, protected mcpName?: string) {
    // Seed the toggles from the def at construction (boot + tests pass them on the def). The live
    // path mutates `toolToggle` / `resourceToggle` directly — `def` is a resolveDef() clone, never
    // the same object the registry holds, so writing to the def later would not reach this adapter.
    if (Array.isArray(def.disabledTools)) {
      this.toolToggle.disabled = new Set(def.disabledTools.filter((t): t is string => typeof t === "string"));
    }
    if (def.exposeResources === false || def.exposeResources === "false") this.resourceToggle.on = false;
  }

  /**
   * The disabled-tool set, shared with the admin API by reference so a toggle is live: the next
   * makeServer() reads this very Set. Public so the toggle endpoint can mutate it in place.
   */
  readonly toolToggle = { disabled: new Set<string>() };

  /** Keep the call log filed under the MCP's current name (see Adapter.rename). */
  rename(name: string): void {
    this.mcpName = name;
  }

  protected get readonly(): boolean {
    return defBool(this.def, "readonly");
  }

  /** Default row cap for a LIMIT-less SELECT; per-MCP override via `maxRows`. */
  protected get maxRows(): number {
    return clampRowLimit(this.def.maxRows, DEFAULT_ROW_LIMIT);
  }

  /** Tool names the user has turned off for this MCP. Applied in makeServer, so a toggle is live:
   *  the next request's tools/list already reflects it, with no restart. */
  protected get disabledTools(): Set<string> {
    return this.toolToggle.disabled;
  }

  /**
   * Live, shared on/off for this MCP's resources — the mirror of the per-tool toggle, but for the
   * whole primitive. Mutated in place by the resources-toggle API so the change is live, and seeded
   * from `def.exposeResources` at construction for the config-form default.
   *
   * "Off" does NOT withdraw the resources capability: `notifications/resources/list_changed`
   * requires the capability to be announced, so off means resources/list returns empty (the client
   * sees no resources) while the capability stays — exactly how a hidden tool stays in tools/list's
   * capability but drops out of its content.
   */
  readonly resourceToggle = { on: true };

  /** Wrap a provider so that while resources are toggled off, discovery answers empty. */
  private gatedResources(provider: ResourceProvider): ResourceProvider {
    const self = this;
    return {
      async list(cursor) {
        return self.resourceToggle.on ? provider.list(cursor) : { resources: [] };
      },
      templates() {
        return self.resourceToggle.on ? provider.templates() : [];
      },
      read(uri) {
        return provider.read(uri);
      },
    };
  }

  /**
   * Resources this adapter exposes, or undefined for none — which is what decides whether the
   * `resources` capability is announced at all. Stateless and cheap to build, since a fresh Server
   * (and so a fresh provider) is made per HTTP request.
   */
  protected resources(): ResourceProvider | undefined {
    return undefined;
  }

  /** A FRESH Server per HTTP request (see Adapter.makeServer). The driver's pool or connection
   *  multiplexes concurrent work, so every one of them can wrap the same one.
   *
   *  Disabled tools are filtered here, so they drop out of tools/list and a call to one returns the
   *  "unknown tool" error the call handler already throws. The filter is read fresh each request — a
   *  toggle mutates the def, and the very next request sees it. */
  makeServer(): Server {
    const disabled = this.disabledTools;
    const tools = disabled.size ? this.tools.filter((t) => !disabled.has(t.name)) : this.tools;
    // The provider is built whenever the adapter has resources to offer (a database to scope to); the
    // on/off toggle gates its contents, not whether the capability is announced.
    const provider = this.resources();
    return makeToolServer(
      tools,
      (tool, args) => this.call(tool, args),
      {
        name: this.mcpName,
        description: this.def.description ? String(this.def.description) : undefined,
        target: this.target,
      },
      provider ? this.gatedResources(provider) : undefined,
    );
  }

  async build(): Promise<Server> {
    await this.open(); // drivers connect lazily; ping() is what actually validates reachability
    return this.makeServer();
  }
}
