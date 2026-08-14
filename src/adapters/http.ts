import { Client, StreamableHTTPClientTransport, type ServerCapabilities } from "@modelcontextprotocol/client";
import type { Server } from "@modelcontextprotocol/server";
import type { Adapter } from "./types.js";
import { makeProxyServer } from "./proxy.js";
import { assertProxyUrl, proxiedFetch } from "./proxy-fetch.js";

export interface HttpOpts {
  /** Registry name of this MCP — the key its call log is filed under. */
  name?: string;
  /** The remote MCP endpoint, e.g. `https://mcp.context7.com/mcp`. */
  url: string;
  /** Sent on every request to the remote. Where a remote's API key goes:
   *  `{ "Authorization": "Bearer ${CONTEXT7_API_KEY}" }` — resolveDef() expands the env reference, so the
   *  config and managed.json keep holding the reference rather than the key. */
  headers?: Record<string, string>;
  /** Route this MCP's traffic through an HTTP(S) proxy (a `${ENV}` ref works like any string
   *  field). For remotes a machine cannot reach directly. Validated at construction. */
  proxy?: string;
  /** What this MCP is for, from the config. Surfaced to clients as MCP `instructions`. */
  description?: string;
  exposeResources?: boolean;
  exposePrompts?: boolean;
}

/**
 * Hosts a REMOTE MCP server reached over streamable HTTP, by connecting to it once and proxying every
 * request to it. The third kind of MCP this gateway serves, after the in-process DB adapters and the
 * stdio children of `proc` — and the one that needs the least: no process to spawn, nothing to
 * orphan, no driver to import.
 *
 * Only streamable HTTP. Some providers still publish an SSE endpoint beside the streamable one, but
 * it is legacy everywhere it appears and untestable here — this gateway serves no GET SSE stream of
 * its own, so there is nothing local to test a client against. Adding it later means adding a test
 * against something real first.
 */
export class HttpAdapter implements Adapter {
  readonly type = "http";
  private client?: Client;
  /** What the remote negotiated. Read once at connect, so the proxy announces its capabilities and
   *  not a fixed guess (see ProxyOpts.remoteCaps). */
  private remoteCaps?: ServerCapabilities;

  constructor(private opts: HttpOpts) {
    if (opts.proxy) assertProxyUrl(opts.proxy); // a bad proxy is a start error, not a first-call mystery
  }

  async build(): Promise<Server> {
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: this.opts.headers ? { headers: { ...this.opts.headers } } : undefined,
      // The SDK accepts a custom fetch for ALL its network requests; a proxied one routes this
      // MCP's traffic (and only this MCP's) through the proxy.
      ...(this.opts.proxy ? { fetch: proxiedFetch(this.opts.proxy) } : {}),
    });
    const client = new Client({ name: "mcp-gateway", version: "1.0" }, { capabilities: {} });
    await client.connect(transport); // runs the initialize handshake — this IS the reachability check
    this.client = client;
    this.remoteCaps = client.getServerCapabilities();
    return this.makeServer();
  }

  /** Fresh proxy Server for one HTTP request (see Adapter.makeServer). Wraps the shared client,
   *  which multiplexes concurrent requests by JSON-RPC id. */
  makeServer(): Server {
    if (!this.client) throw new Error("not started");
    return makeProxyServer(this.client, {
      name: this.opts.name,
      description: this.opts.description,
      exposeResources: this.opts.exposeResources,
      exposePrompts: this.opts.exposePrompts,
      remoteCaps: this.remoteCaps,
    });
  }

  rename(name: string): void {
    this.opts.name = name;
  }

  /**
   * Connected or not — and deliberately nothing more.
   *
   * The registry probes every started MCP on a 15s timer, which against a metered third-party
   * endpoint would be thousands of requests a day that nobody asked for. MCP makes `ping` optional
   * (either side MAY send one), so not sending it is within spec. Reachability is established once by
   * the initialize handshake in build(); after that a real failure surfaces on a real call, where the
   * traffic log already records it. The cost is a health dot that reads "up" for a remote that went
   * down since the last call — the honest price of not generating traffic.
   */
  async ping(): Promise<void> {
    if (!this.client) throw new Error("not started");
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.remoteCaps = undefined;
    try { await client?.close(); } catch { /* already gone */ }
  }
}
