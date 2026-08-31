import { describe, it, expect } from "vitest";
import { renderResult, makeToolServer, DEFAULT_LIMITS } from "../src/adapters/tool-server.js";
import { ResourceFault, type ResourceProvider } from "../src/adapters/resources.js";
import { openSession } from "../src/introspect.js";

describe("renderResult output budget", () => {
  it("pretty-prints a small result (readable, and cheap at this size)", () => {
    expect(renderResult({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("passes a string through untouched", () => {
    expect(renderResult("PONG")).toBe("PONG");
  });

  it("decodes Buffers instead of dumping {type:'Buffer',data:[...]}", () => {
    expect(renderResult(Buffer.from("hello"))).toBe("hello");
    expect(renderResult([Buffer.from("a"), Buffer.from("b")])).toBe(JSON.stringify(["a", "b"], null, 2));
  });

  it("decodes Buffers NESTED in row objects — the shape a BLOB column actually arrives in", () => {
    // mysql2's BLOB and pg's bytea both surface as { rowCount, rows: [{ col: <Buffer> }] }; the old
    // walk only touched top-level Buffers and array elements, so a single BLOB column dumped its
    // bytes as a JSON number array and burned the whole budget.
    const res = { rowCount: 2, rows: [{ id: 1, blob: Buffer.from("alpha") }, { id: 2, blob: Buffer.from("beta") }] };
    expect(JSON.parse(renderResult(res))).toEqual({ rowCount: 2, rows: [{ id: 1, blob: "alpha" }, { id: 2, blob: "beta" }] });
    // Class instances keep their toJSON: a Date stays a Date (serialized as its ISO string), it is
    // not rebuilt into an empty plain object.
    const withDate = { at: new Date(0), rows: [Buffer.from("x")] };
    expect(JSON.parse(renderResult(withDate)).at).toBe("1970-01-01T00:00:00.000Z");
  });

  it("caps item count and says how much was dropped", () => {
    const out = renderResult(Array.from({ length: 5000 }, (_, i) => i), { maxItems: 10, maxBytes: 1_000_000 });
    expect(out).toContain("showing the first 10 of 5000 items");
    expect(out).toContain("Narrow the request");
    // The rendered array really is trimmed, not just annotated.
    expect(JSON.parse(out.slice(0, out.indexOf("\n\n[")))).toHaveLength(10);
  });

  it("sheds items to fit the byte budget and stays valid JSON", () => {
    const rows = Array.from({ length: 20000 }, (_, i) => ({ id: i, name: `user-${i}`, email: `u${i}@example.com` }));
    const out = renderResult(rows, { maxItems: 100000, maxBytes: 4096 });
    const json = out.slice(0, out.indexOf("\n\n["));
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(4096);
    expect(() => JSON.parse(json)).not.toThrow(); // shed whole elements, never cut mid-token
    expect(JSON.parse(json).length).toBeLessThan(rows.length);
    expect(out).toContain("of 20000 items");
  });

  it("sheds rows from a { rowCount, rows } result — the shape SQL actually returns", () => {
    // The live case: SELECT * on a wide table produced a 262 KB reply that was hard-cut mid-string,
    // so the model received JSON it could not parse.
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, blob: "x".repeat(1500) }));
    const out = renderResult({ rowCount: rows.length, rows }, { maxItems: 1000, maxBytes: 16 * 1024 });
    const json = out.slice(0, out.indexOf("\n\n["));
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(16 * 1024);
    const parsed = JSON.parse(json); // the whole point: still parseable
    expect(parsed.rows.length).toBeLessThan(200);
    // rowCount must describe the rows present, not the rows that were dropped.
    expect(parsed.rowCount).toBe(parsed.rows.length);
    expect(out).toContain("of 200 items");
  });

  it("caps items inside a wrapper too (redis_scan's { cursor, keys })", () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `k:${i}`);
    const out = renderResult({ cursor: "42", keys, done: false }, { maxItems: 10, maxBytes: 1_000_000 });
    const parsed = JSON.parse(out.slice(0, out.indexOf("\n\n[")));
    expect(parsed.keys).toHaveLength(10);
    expect(parsed.cursor).toBe("42"); // the fields around the list survive
    expect(parsed.done).toBe(false);
    expect(out).toContain("showing the first 10 of 5000 items");
  });

  it("hard-cuts only when there is no list to shed", () => {
    const out = renderResult({ note: "y".repeat(50_000) }, { maxItems: 10, maxBytes: 1000 });
    expect(out).toContain("no longer valid JSON");
  });

  it("truncates a huge string at the byte budget", () => {
    const out = renderResult("x".repeat(50_000), { maxItems: 10, maxBytes: 1000 });
    expect(out.startsWith("x".repeat(1000))).toBe(true);
    expect(out).toContain("truncated at 1000 bytes");
  });

  it("keeps an unbounded reply from blowing up the process", () => {
    // 200k redis keys measured at 5.2 MB of JSON before this cap existed.
    const keys = Array.from({ length: 200_000 }, (_, i) => `session:user:${i}:cache`);
    const out = renderResult(keys);
    expect(Buffer.byteLength(out)).toBeLessThan(DEFAULT_LIMITS.maxBytes + 500);
  });
});

describe("renderResult byte budget is measured in bytes", () => {
  it("keeps a multi-byte string within the byte budget, not the code-unit budget", () => {
    const out = renderResult("中".repeat(300000), { maxItems: 10, maxBytes: 1000 });
    const body = out.slice(0, out.indexOf("\n\n[truncated"));
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1000);
  });

  it("never cuts a surrogate pair in half", () => {
    const out = renderResult("😀".repeat(2000), { maxItems: 10, maxBytes: 999 });
    const body = out.slice(0, out.indexOf("\n\n[truncated"));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body)).toBe(false);
  });

  it("keeps the no-list hard cut within the byte budget too", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) wide["列" + i] = "值".repeat(20);
    const out = renderResult(wide, { maxItems: 10, maxBytes: 2000 });
    const cut = out.indexOf("\n\n[");
    expect(Buffer.byteLength(cut < 0 ? out : out.slice(0, cut))).toBeLessThanOrEqual(2000);
  });
});

describe("makeToolServer resources", () => {
  const tools = [{ name: "noop", description: "n", inputSchema: { type: "object" } }];
  const call = async () => "ok";

  /** Drive the server through a real MCP session, the way a client (and the panel) does. */
  async function session(resources?: ResourceProvider) {
    const server = makeToolServer(tools, call, { name: "t" }, resources);
    return openSession(server);
  }

  it("refuses a tools/call for a name the advertised list does not carry", async () => {
    // The advertised list is the contract: a tool hidden from tools/list (a readonly mongo's write
    // tools, or anything the operator disabled) must not be callable by naming it directly. The
    // call fn here KNOWS the name — the handler must still refuse, which is exactly the bug.
    const seen: string[] = [];
    const client = await openSession(makeToolServer(
      [{ name: "visible", description: "v", inputSchema: { type: "object" } }],
      async (name) => { seen.push(name); return "ran"; },
      { name: "t" },
    ));
    try {
      await client.callTool({ name: "visible", arguments: {} } as never);
      await expect(client.callTool({ name: "hidden_write", arguments: {} } as never)).rejects.toThrow(/unknown tool: hidden_write/);
      expect(seen).toEqual(["visible"]); // the hidden name never reached the adapter
    } finally {
      await client.close();
    }
  });

  const provider: ResourceProvider = {
    async list(cursor?: string) {
      if (cursor === "1") return { resources: [{ uri: "x://b", name: "b" }] };
      return { resources: [{ uri: "x://a", name: "a", description: "first" }], nextCursor: "1" };
    },
    templates: () => [{ uriTemplate: "x://{id}", name: "anything" }],
    async read(uri: string) {
      if (uri === "x://huge") return [{ uri, text: "y".repeat(400_000) }];
      if (uri !== "x://a") throw new ResourceFault(`no such resource: ${uri}`);
      return [{ uri, mimeType: "text/plain", text: "hello" }];
    },
  };

  it("announces the resources capability only when a provider is given", async () => {
    const without = await session();
    expect(without.getServerCapabilities()?.resources).toBeUndefined();
    // v2 returns empty (not a throw) when the capability isn't advertised — still graceful, no crash.
    expect((await without.listResources()).resources).toEqual([]);
    await without.close();

    const with_ = await session(provider);
    expect(with_.getServerCapabilities()?.resources).toEqual({ listChanged: true });
    await with_.close();
  });

  it("announces resources.listChanged (so a toggle can notify) but never subscribe", async () => {
    const client = await session(provider);
    const caps = client.getServerCapabilities()?.resources ?? {};
    expect(caps.listChanged).toBe(true);
    expect("subscribe" in caps).toBe(false); // subscribe would oblige polling the catalog forever
    await client.close();
  });

  it("lists, pages, and lists templates", async () => {
    const client = await session(provider);
    // v2's listResources() auto-aggregates every page, so drop to the raw request to exercise the
    // server's own per-page cursor — the behavior under test.
    const p1 = await client.request({ method: "resources/list", params: {} });
    expect(p1.resources[0]).toMatchObject({ uri: "x://a", description: "first" });
    expect(p1.nextCursor).toBe("1");
    const p2 = await client.request({ method: "resources/list", params: { cursor: "1" } });
    expect(p2.resources[0].uri).toBe("x://b");
    expect(p2.nextCursor).toBeUndefined();
    const t = await client.listResourceTemplates();
    expect(t.resourceTemplates[0].uriTemplate).toBe("x://{id}");
    await client.close();
  });

  it("reads contents", async () => {
    const client = await session(provider);
    const out = await client.readResource({ uri: "x://a" });
    expect(out.contents[0]).toMatchObject({ uri: "x://a", mimeType: "text/plain", text: "hello" });
    await client.close();
  });

  it("answers -32602 for a URI that names nothing, as the spec requires", async () => {
    const client = await session(provider);
    await expect(client.readResource({ uri: "x://gone" })).rejects.toMatchObject({ code: -32602 });
    await client.close();
  });

  it("holds a read to the same byte budget as a tool result", async () => {
    const client = await session(provider);
    const out = await client.readResource({ uri: "x://huge" });
    const text = String((out.contents[0] as { text?: string }).text ?? "");
    expect(Buffer.byteLength(text)).toBeLessThan(DEFAULT_LIMITS.maxBytes + 200);
    expect(text).toContain("truncated at");
    await client.close();
  });
});
