import { describe, it, expect, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { makeProxyServer } from "../src/adapters/proxy.js";
import { openSession } from "../src/introspect.js";

/**
 * A remote MCP that paginates: `all` is served in pages of `pageSize`, cursors are "1", "2", ...
 *
 * `seen` records every cursor the proxy forwarded to it, which is the assertion that matters — that
 * the caller's cursor reached the remote, rather than the answer merely looking plausible.
 */
function paginatingRemote(all: unknown[], pageSize: number) {
  const pages: unknown[][] = [];
  for (let i = 0; i < all.length; i += pageSize) pages.push(all.slice(i, i + pageSize));
  const seen: (string | undefined)[] = [];
  const page = (cursor?: string) => {
    seen.push(cursor);
    const idx = cursor ? parseInt(cursor, 10) : 0;
    return {
      items: pages[idx] ?? [],
      nextCursor: idx + 1 < pages.length ? String(idx + 1) : undefined,
    };
  };
  const client = {
    listTools: ((p?: { cursor?: string }) => {
      const r = page(p?.cursor);
      return Promise.resolve({ tools: r.items, nextCursor: r.nextCursor });
    }) as never,
    listResources: ((p?: { cursor?: string }) => {
      const r = page(p?.cursor);
      return Promise.resolve({ resources: r.items, nextCursor: r.nextCursor });
    }) as never,
    listPrompts: ((p?: { cursor?: string }) => {
      const r = page(p?.cursor);
      return Promise.resolve({ prompts: r.items, nextCursor: r.nextCursor });
    }) as never,
  } as unknown as Client;
  return { client, seen };
}

const tools = Array.from({ length: 130 }, (_, i) => ({
  name: `t${i}`,
  description: `tool ${i}`,
  inputSchema: { type: "object", properties: {} },
}));

/**
 * The upstream `Client` the proxy holds walks a remote's pagination itself when called with no
 * cursor, so `tools/list` with no cursor is answered with every page aggregated. These tests pin
 * the other mode: a caller that DOES send a cursor gets that one page, and the remote's own
 * `nextCursor` comes back — the pair that makes explicit per-page paging work at all.
 */
describe("makeProxyServer forwards cursor pagination", () => {
  it("aggregates every page when the caller sends no cursor", async () => {
    const { client: remote, seen } = paginatingRemote(tools, 50);
    const session = await openSession(makeProxyServer(remote, { name: "p" }));
    try {
      const res = await session.listTools();
      expect((res.tools as { name: string }[]).map((t) => t.name)).toEqual(tools.map((t) => t.name));
      expect(res.nextCursor).toBeUndefined();
      expect(seen).toEqual([undefined, "1", "2"]); // the walk happened upstream, page by page
    } finally {
      await session.close();
    }
  });

  it("answers one page, with the remote's nextCursor, when the caller sends a cursor", async () => {
    const { client: remote, seen } = paginatingRemote(tools, 50);
    const session = await openSession(makeProxyServer(remote, { name: "p" }));
    try {
      const second = await session.listTools({ cursor: "1" });
      expect((second.tools as { name: string }[]).map((t) => t.name)).toEqual(
        tools.slice(50, 100).map((t) => t.name),
      );
      expect(second.nextCursor).toBe("2");

      const third = await session.listTools({ cursor: second.nextCursor! });
      expect((third.tools as { name: string }[]).map((t) => t.name)).toEqual(
        tools.slice(100, 130).map((t) => t.name),
      );
      expect(third.nextCursor).toBeUndefined();

      // The cursors reached the remote unchanged. Dropping them answered page one every time.
      expect(seen).toEqual(["1", "2"]);
    } finally {
      await session.close();
    }
  });

  it("still strips `annotations`", async () => {
    const annotated = [{ name: "a", inputSchema: { type: "object" }, annotations: { title: "A" } }];
    const { client: remote } = paginatingRemote(annotated, 50);
    const session = await openSession(makeProxyServer(remote, { name: "p" }));
    try {
      const res = await session.listTools();
      expect(res.tools[0]).not.toHaveProperty("annotations");
    } finally {
      await session.close();
    }
  });

  it("passes a cursor through for resources and prompts too", async () => {
    const items = Array.from({ length: 70 }, (_, i) => ({ uri: `x://${i}`, name: `r${i}` }));
    for (const kind of ["resources", "prompts"] as const) {
      const { client: remote, seen } = paginatingRemote(items, 50);
      const session = await openSession(makeProxyServer(remote, { name: "p" }));
      try {
        const page =
          kind === "resources"
            ? await session.listResources({ cursor: "1" })
            : await session.listPrompts({ cursor: "1" });
        expect((page as { resources?: unknown[]; prompts?: unknown[] })[kind]).toHaveLength(20);
        expect(seen).toEqual(["1"]);
      } finally {
        await session.close();
      }
    }
  });

  /** A remote whose list fails must not be reported as a remote with nothing in it, silently. */
  it("answers an empty list when the remote's list fails, and says so in the log", async () => {
    const logs: unknown[] = [];
    const remote = {
      listTools: (() => Promise.reject(new Error("exceeded listMaxPages (64)"))) as never,
    } as unknown as Client;
    const session = await openSession(makeProxyServer(remote, { name: "flaky" }));
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    try {
      const res = await session.listTools();
      expect(res.tools).toEqual([]);
    } finally {
      spy.mockRestore();
      await session.close();
    }
    const line = logs.map(String).join("");
    expect(line).toContain("proxied list failed");
    expect(line).toContain("listMaxPages");
  });
});
