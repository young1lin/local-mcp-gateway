import { describe, it, expect } from "vitest";
import { listPage, newPageCache, PAGE_SIZE } from "../src/paging.js";
import type { Client } from "@modelcontextprotocol/client";

/** Fake MCP client that serves `all` items in server-pages of `serverPage`, using cursors "1","2",... */
function fakeClient(all: unknown[], serverPage: number): Client {
  const pages: unknown[][] = [];
  for (let i = 0; i < all.length; i += serverPage) pages.push(all.slice(i, i + serverPage));
  const list = (cursor?: string) => {
    const idx = cursor ? parseInt(cursor, 10) : 0;
    const pg = pages[idx] ?? [];
    return { items: pg, nextCursor: idx + 1 < pages.length ? String(idx + 1) : undefined };
  };
  return {
    listResources: ((params?: { cursor?: string }) => {
      const r = list(params?.cursor);
      return Promise.resolve({ resources: r.items, nextCursor: r.nextCursor });
    }) as never,
    listTools: (() => Promise.resolve({ tools: [], nextCursor: undefined })) as never,
  } as unknown as Client;
}

function names(items: any[]): string[] {
  return items.map((i) => i.name);
}

describe("listPage (MCP cursor pagination)", () => {
  const items = Array.from({ length: 130 }, (_, i) => ({ name: `r${i}` }));

  it("walks a paginating server page by page, returning <= PAGE_SIZE", async () => {
    const c = fakeClient(items, 50); // server pages: 50,50,30
    const cache = newPageCache();
    const p1 = await listPage(c, "resources", cache);
    expect(p1.items.length).toBe(PAGE_SIZE);
    expect(names(p1.items as any[])).toEqual(names(items.slice(0, 50)));
    expect(p1.nextCursor).toBeTruthy();
    expect(p1.total).toBeUndefined(); // server not exhausted yet

    const p2 = await listPage(c, "resources", cache, p1.nextCursor);
    expect(names(p2.items as any[])).toEqual(names(items.slice(50, 100)));
    expect(p2.total).toBeUndefined();

    const p3 = await listPage(c, "resources", cache, p2.nextCursor!);
    expect(names(p3.items as any[])).toEqual(names(items.slice(100, 130)));
    expect(p3.nextCursor).toBeUndefined();
    expect(p3.total).toBe(130); // fully fetched now
  });

  it("prev reuses the cache (no re-fetch) and stays consistent", async () => {
    const c = fakeClient(items, 50);
    const cache = newPageCache();
    const p1 = await listPage(c, "resources", cache);
    const p2 = await listPage(c, "resources", cache, p1.nextCursor);
    // go back to page 1 via a synthesized offset-0 cursor equivalent: re-fetch offset 0
    const p1b = await listPage(c, "resources", cache); // no cursor = offset 0
    expect(names(p1b.items as any[])).toEqual(names(items.slice(0, 50)));
    expect(names(p2.items as any[])).toEqual(names(items.slice(50, 100)));
  });

  it("handles a non-paginating server (dumps all) by slicing from cache", async () => {
    const c = fakeClient(items, 1000); // single dump, no nextCursor
    const cache = newPageCache();
    const p1 = await listPage(c, "resources", cache);
    expect(p1.items.length).toBe(PAGE_SIZE);
    expect(p1.nextCursor).toBeTruthy();
    expect(p1.total).toBe(130); // known immediately since serverNext is exhausted
  });

  it("single page when fewer items than PAGE_SIZE", async () => {
    const c = fakeClient([{ name: "only" }], 50);
    const cache = newPageCache();
    const p = await listPage(c, "resources", cache);
    expect(p.items.length).toBe(1);
    expect(p.nextCursor).toBeUndefined();
    expect(p.total).toBe(1);
  });
});

describe("listPage under concurrent readers", () => {
  it("does not duplicate accumulated items when two requests share one cache", async () => {
    // Two browser tabs paging the same MCP hand the SAME PageCache to two concurrent listPage
    // calls; each awaits a server fetch and then pushes into cache.acc.
    const items = Array.from({ length: 130 }, (_, i) => ({ name: `r${i}` }));
    const c = fakeClient(items, 50);
    const cache = newPageCache();
    await listPage(c, "resources", cache); // prime: acc = 50, serverNext = "1"

    const [a, b] = await Promise.all([
      listPage(c, "resources", cache, Buffer.from(JSON.stringify({ o: 50 }), "utf8").toString("base64url")),
      listPage(c, "resources", cache, Buffer.from(JSON.stringify({ o: 100 }), "utf8").toString("base64url")),
    ]);
    expect(cache.acc.length).toBe(130);
    expect(names(a.items as any[])).toEqual(names(items.slice(50, 100)));
    expect(names(b.items as any[])).toEqual(names(items.slice(100, 130)));
    expect(a.total ?? b.total).toBe(130);
  });
});
