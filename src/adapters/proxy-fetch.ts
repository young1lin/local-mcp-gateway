import { fetch as undiciFetch, ProxyAgent } from "undici";

/**
 * Per-MCP outbound proxy for the remote adapters (`http`, `rest`): a machine that cannot reach a
 * site directly often can through a local proxy, and that is a property of the MCP, not of the
 * gateway — hence a `proxy` field on the def rather than a global setting. Deliberately NOT
 * `setGlobalDispatcher`: one MCP's proxy must never reroute another MCP's traffic.
 */

/** Must be http(s):// — undici's ProxyAgent speaks CONNECT over either. A missing scheme is the
 *  classic typo and socks5 is unsupported, and both belong as a loud start error rather than a
 *  mysterious connect failure on the first call. Returns the trimmed URL. */
export function assertProxyUrl(proxy: string): string {
  const p = proxy.trim();
  if (!/^https?:\/\//i.test(p)) {
    throw new Error(`proxy must be an http:// or https:// URL, got ${JSON.stringify(proxy)}`);
  }
  return p;
}

const fetchers = new Map<string, typeof fetch>();

/**
 * A fetch that routes through the given proxy.
 *
 * One ProxyAgent per proxy URL, memoized at module level: an agent is just a connection pool, so
 * sharing it across MCPs on the same proxy is exactly right — and it spares every adapter the
 * lifecycle wiring of owning and closing one. The set of distinct proxies is one or two in practice.
 */
export function proxiedFetch(proxy: string): typeof fetch {
  const url = assertProxyUrl(proxy);
  let fn = fetchers.get(url);
  if (!fn) {
    const dispatcher = new ProxyAgent(url);
    fn = ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher,
      } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch;
    fetchers.set(url, fn);
  }
  return fn;
}
