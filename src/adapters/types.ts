import type { Server } from "@modelcontextprotocol/server";

export interface Adapter {
  readonly type: string;
  /** Build the MCP Server once (holds its own DB connection). Unconnected to any transport. */
  build(): Promise<Server>;
  /**
   * Create a FRESH request-handling Server for one HTTP request. The SDK Server holds a single
   * connected transport, so a shared server races under concurrent requests (a client sends
   * tools/list + prompts/list in parallel) and misroutes responses. Each request gets its own
   * server wrapping the shared child client (which does handle concurrency). Optional; adapters
   * that don't set it fall back to the single built server (fine when requests are serial).
   */
  makeServer?(): Server;
  /** Close DB connections on shutdown. Optional. */
  close?(): Promise<void>;
  /** Lightweight reachability probe of the underlying DB; throws with the reason on failure. Optional. */
  ping?(): Promise<void>;
  /** Captured stderr of a spawned child, for the panel's log view. Optional (proc only). */
  logs?(): string;
  /** Follow a registry rename, so calls keep being logged under the MCP's current name. Optional. */
  rename?(name: string): void;
  /**
   * Live, shared tool-toggle state: the disabled tool names, in a Set both the adapter (reads it in
   * makeServer) and the admin API (mutates it on toggle) hold by reference. Optional; absent on
   * adapters whose tool set is not a static, gateway-owned list (proc proxies a child).
   */
  toolToggle?: { disabled: Set<string> };
  /** Live, shared resources on/off — the master switch, mirrored from the per-tool toggle. Optional;
   *  absent on adapters that do not own a static resource set. */
  resourceToggle?: { on: boolean };
  /** Root PIDs of any spawned subtree, so the memory view knows what to measure. Optional (proc only);
   *  an adapter that returns nothing has no child process, and measuring can be skipped entirely. */
  pids?(): number[];
}
