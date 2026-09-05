import type { Client } from "@modelcontextprotocol/client";
import type { ServerCapabilities } from "@modelcontextprotocol/client";
import { Server, type Tool } from "@modelcontextprotocol/server";
import { contentText, logged } from "../calls.js";
import { log } from "../log.js";

export interface ProxyOpts {
  /** Registry name of this MCP — the key its call log is filed under. */
  name?: string;
  /** What this MCP is for, from the config. Surfaced to clients as MCP `instructions`. */
  description?: string;
  /** Expose the remote's resources (default true). Set false to hide noisy resources (e.g. a DB's
   *  thousands of table-schema resources) so MCP clients don't flood context with them. */
  exposeResources?: boolean;
  /** Expose the remote's prompts (default true). */
  exposePrompts?: boolean;
  /**
   * Deadline for a single proxied `tools/call`, in ms. Omit to inherit the SDK's own default
   * (60s) — fine for a remote whose replies are fast, wrong for anything doing real inference.
   * The caller owns this because only it knows what its remote does; see PROC_CALL_TIMEOUT_MS.
   */
  callTimeoutMs?: number;
  /**
   * What the remote actually negotiated, when known. A capability is announced only if the toggle
   * above allows it AND the remote has it — otherwise clients ask for lists that cannot exist, which
   * against a metered remote is a round trip billed for a guaranteed empty answer. Omit to announce
   * whatever the toggles allow (a spawned child that answers before its capabilities are read).
   */
  remoteCaps?: ServerCapabilities;
}

/**
 * Build an MCP Server whose handlers forward every request to an already-connected client.
 *
 * Transport-agnostic on purpose: the client may be talking to a spawned stdio child (`proc`) or to a
 * remote HTTP MCP (`http`). Everything a proxied MCP needs — call logging, the `annotations` strip for
 * older clients, the resource/prompt gates — is the same either way and lives here once.
 */
export function makeProxyServer(client: Client, opts: ProxyOpts = {}): Server {
  const has = (cap: keyof ServerCapabilities): boolean => !opts.remoteCaps || !!opts.remoteCaps[cap];
  const exposeResources = opts.exposeResources !== false && has("resources");
  const exposePrompts = opts.exposePrompts !== false && has("prompts");
  const capabilities: Record<string, Record<string, never>> = { tools: {} };
  if (exposeResources) capabilities.resources = {};
  if (exposePrompts) capabilities.prompts = {};
  const server = new Server(
    { name: "mcp-gateway-proxy", version: "1.0" },
    { capabilities, ...(opts.description ? { instructions: opts.description } : {}) },
  );
  /**
   * An empty list beats a broken one — a remote that fails to answer tools/list should not take the
   * client's whole session down. But it must not be SILENT: an empty result is indistinguishable
   * from "this server has no tools", so the one thing that says otherwise is this log line. The
   * failure worth naming is the SDK's own `ListPaginationExceeded`, thrown when a remote's
   * pagination has not converged within ClientOptions.listMaxPages (64) — a real remote with more
   * pages than that reported zero tools here, with nothing anywhere to say why.
   */
  const safe = async <T>(what: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      log("warn", "proxied list failed; answering empty", {
        mcp: opts.name, what, err: (err as Error)?.message ?? String(err),
      });
      return fallback;
    }
  };

  /**
   * Forward the caller's cursor, when it sent one.
   *
   * The SDK client's list methods have two modes: called with no cursor they walk the remote's
   * pagination themselves and return every page aggregated; called with `{ cursor }` they fetch
   * exactly that one page. Passing the caller's cursor through is what makes explicit per-page
   * paging possible AT ALL — without it a caller holding a cursor is silently answered page one
   * again. The remote's cursors are opaque strings, so handing them back and forth unchanged is
   * the whole of it.
   */
  const cursorOf = (params: { cursor?: unknown } | undefined): { cursor: string } | undefined =>
    typeof params?.cursor === "string" && params.cursor ? { cursor: params.cursor } : undefined;
  // Strip `annotations` (added in protocol 2025-03-26) from every tool. Some clients negotiate an
  // older version over HTTP — Claude Code requests 2024-11-05 — under which `annotations` is an
  // unknown key; strict schema parsing then rejects the whole tools/list ("tools fetch failed").
  server.setRequestHandler('tools/list', async (req) => {
    const res = await safe("tools/list", client.listTools(cursorOf(req.params)), { tools: [] });
    const tools = (res.tools ?? []).map((t: Record<string, unknown>) => {
      const out = { ...t };
      delete out.annotations;
      return out;
    });
    const next = (res as { nextCursor?: string }).nextCursor;
    // The remote already returned spec-shaped Tool entries; the local map widens them to a record
    // (only to delete `annotations`), so cast back to the spec type the handler must return.
    return { tools: tools as unknown as Tool[], ...(next ? { nextCursor: next } : {}) };
  });
  // The remote's answer is logged as the client sees it, including an in-band `isError` failure.
  server.setRequestHandler('tools/call', async (req) =>
    logged(
      opts.name,
      req.params.name,
      req.params.arguments,
      () => client.callTool(req.params as never, opts.callTimeoutMs ? { timeout: opts.callTimeoutMs } : undefined),
      (result) => ({ ok: !(result as { isError?: boolean }).isError, output: contentText(result) }),
    ),
  );
  // Resource/prompt handlers are registered only when exposed: the SDK requires the matching
  // capability to be advertised for a handler, and we hide resources (a DB's thousands of table
  // schemas) to keep client context clean. A probe against a hidden capability gets Method Not Found.
  if (exposeResources) {
    server.setRequestHandler('resources/list', async (req) =>
      safe("resources/list", client.listResources(cursorOf(req.params)), { resources: [] }));
    // Logged like tools/call above (and like the direct adapters' mountResources): a read is a
    // billed/observable action on the remote, and the Logs tab must show it either way.
    server.setRequestHandler('resources/read', async (req) =>
      logged(
        opts.name,
        "resources/read",
        { uri: (req.params as { uri?: string }).uri },
        () => client.readResource(req.params as never),
        (result) => ({ ok: true, output: JSON.stringify(result).slice(0, 200) }),
      ));
  }
  if (exposePrompts) {
    server.setRequestHandler('prompts/list', async (req) =>
      safe("prompts/list", client.listPrompts(cursorOf(req.params)), { prompts: [] }));
    server.setRequestHandler('prompts/get', async (req) => client.getPrompt(req.params as never));
  }
  return server;
}
