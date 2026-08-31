import type { Client } from "@modelcontextprotocol/client";

/** Gateway page size for tools/resources browsing. */
export const PAGE_SIZE = 50;

export type ListKind = "tools" | "resources" | "prompts";

/**
 * Incremental, server-side page cache. `acc` grows as the user pages forward; `serverNext` is the
 * MCP `nextCursor` to continue fetching from the underlying server (undefined once exhausted).
 * Lives on the registry entry so it persists across page requests and is cleared on (re)start.
 */
export interface PageCache {
  acc: unknown[];
  serverNext?: string;
  started: boolean;
  /** Last time a page was served from this cache; used to expire it (see PAGE_CACHE_TTL_MS). */
  touchedAt: number;
  /** Chain that serializes fills of this cache (see listPage). */
  queue?: Promise<void>;
}

/** An idle page cache is dropped after this long. A server that dumps everything at once (a mysql
 *  schema with thousands of table resources) otherwise keeps that whole list resident for the
 *  lifetime of the process. */
export const PAGE_CACHE_TTL_MS = 60000;

export function newPageCache(): PageCache {
  return { acc: [], started: false, touchedAt: Date.now() };
}

export function isPageCacheStale(cache: PageCache, now = Date.now()): boolean {
  return now - cache.touchedAt > PAGE_CACHE_TTL_MS;
}

/** Encode/decode the gateway cursor as an opaque offset token (base64url, URL-safe). */
function encOffset(o: number): string {
  return Buffer.from(JSON.stringify({ o }), "utf8").toString("base64url");
}
function decOffset(cursor?: string): number {
  if (!cursor) return 0;
  try {
    return (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).o) | 0;
  } catch {
    return 0;
  }
}

async function fetchFromServer(
  client: Client,
  kind: ListKind,
  cursor?: string,
): Promise<{ items: unknown[]; nextCursor?: string }> {
  if (kind === "tools") {
    const r = await client.listTools(cursor ? { cursor } : undefined);
    const rr = r as { tools?: unknown[]; nextCursor?: string };
    return { items: rr.tools ?? [], nextCursor: rr.nextCursor };
  }
  if (kind === "prompts") {
    const r = await client.listPrompts(cursor ? { cursor } : undefined);
    const rr = r as { prompts?: unknown[]; nextCursor?: string };
    return { items: rr.prompts ?? [], nextCursor: rr.nextCursor };
  }
  const r = await client.listResources(cursor ? { cursor } : undefined);
  const rr = r as { resources?: unknown[]; nextCursor?: string };
  return { items: rr.resources ?? [], nextCursor: rr.nextCursor };
}

/**
 * Return one page (≤ PAGE_SIZE items) using MCP cursor pagination. The cache is filled lazily:
 * - Servers that paginate (return nextCursor) are followed page by page as the offset advances.
 * - Servers that dump everything (no nextCursor, e.g. a mysql schema's table resources) fill `acc` once,
 *   then paging is pure slicing — the full list never leaves the gateway.
 * `total` is included only once the server is fully fetched (serverNext exhausted).
 */
export async function listPage(
  client: Client,
  kind: ListKind,
  cache: PageCache,
  cursor?: string,
): Promise<{ items: unknown[]; nextCursor?: string; total?: number }> {
  const offset = Math.max(0, decOffset(cursor));
  cache.touchedAt = Date.now();
  // One cache is shared by every request against this MCP+kind, so two readers (two panel tabs, or
  // a fast click landing on the poll) used to read the same acc.length and serverNext, both fetch
  // the same server page, and both push it — duplicating rows and inflating `total`. Serialize the
  // fill; the slicing below is synchronous and safe once it has run.
  const fill = (cache.queue ?? Promise.resolve()).then(async () => {
    if (!cache.started) {
      const p = await fetchFromServer(client, kind);
      cache.acc = p.items;
      cache.serverNext = p.nextCursor;
      cache.started = true;
    }
    // Pull more from the server until the requested window is covered or the server is exhausted.
    while (offset + PAGE_SIZE > cache.acc.length && cache.serverNext) {
      const p = await fetchFromServer(client, kind, cache.serverNext);
      cache.acc.push(...p.items);
      cache.serverNext = p.nextCursor;
    }
  });
  // Swallow on the chain only — the caller still sees the failure via `fill`, but one failed fetch
  // must not wedge every later page behind it.
  cache.queue = fill.then(() => undefined, () => undefined);
  await fill;
  const items = cache.acc.slice(offset, offset + PAGE_SIZE);
  const more = offset + PAGE_SIZE < cache.acc.length || !!cache.serverNext;
  const total = cache.serverNext ? undefined : cache.acc.length;
  return { items, nextCursor: more ? encOffset(offset + PAGE_SIZE) : undefined, total };
}
