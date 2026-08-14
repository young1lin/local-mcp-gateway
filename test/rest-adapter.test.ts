import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { makeAdapter } from "../src/adapters/factory.js";
import { RestAdapter } from "../src/adapters/rest.js";
import type { Adapter } from "../src/adapters/types.js";
import { openSession } from "../src/introspect.js";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A stand-in for the third-party API: records what arrived and answers what the test tells it to. */
async function api() {
  const seen: Seen[] = [];
  let status = 200;
  let payload: unknown = { ok: true };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((r) => server.listen({ port: 0, host: "127.0.0.1" }, () => r()));
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    answer(s: number, p: unknown) { status = s; payload = p; },
    stop() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/** Drive the adapter the way a client does — through its MCP server, not through internals. */
async function session(adapter: RestAdapter) {
  const client = await openSession(adapter.makeServer());
  return {
    listTools: () => client.listTools(),
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
      const res = await client.callTool({ name, arguments: args });
      return JSON.parse((res.content as { text: string }[])[0].text);
    },
    callRaw: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
}

/** A declared REST API — the shape this feature exists for. */
function searchDef(baseUrl: string) {
  return {
    type: "rest",
    description: "Example search API (REST).",
    baseUrl,
    headers: { Authorization: "Bearer sk-test" },
    tools: [
      {
        name: "search",
        description: "Search the index.",
        input: {
          query: { type: "string", required: true, description: "What to search for" },
          count: { type: "number", default: 10 },
          recency: { type: "string", enum: ["oneDay", "noLimit"] },
        },
        request: {
          method: "POST",
          path: "/v1/search",
          body: {
            q: "{{query}}",
            engine: "default",
            safe: false,
            count: "{{count}}",
            recency: "{{recency}}",
            detail: "high",
          },
        },
        pick: ["results"],
      },
    ],
  };
}

describe("RestAdapter", () => {
  it("is what the factory builds for type rest", () => {
    expect(makeAdapter({ type: "rest", baseUrl: "https://x.test", tools: [] })).toBeInstanceOf(RestAdapter);
  });

  it("exposes each declared tool with its compiled schema", async () => {
    const remote = await api();
    const a = new RestAdapter(searchDef(remote.baseUrl), "example");
    await a.build();
    const s = await session(a);
    try {
      const list = await s.listTools();
      expect(list.tools.map((t) => t.name)).toEqual(["search"]);
      const schema = list.tools[0].inputSchema as { required?: string[]; properties: Record<string, { enum?: unknown[] }> };
      expect(schema.required).toEqual(["query"]);
      expect(schema.properties.recency.enum).toEqual(["oneDay", "noLimit"]);
    } finally {
      await s.close();
      remote.stop();
    }
  });

  it("sends the rendered request, with the declared headers and the default filled in", async () => {
    const remote = await api();
    const a = new RestAdapter(searchDef(remote.baseUrl), "example");
    await a.build();
    const s = await session(a);
    try {
      await s.call("search", { query: "mcp gateway" });
      expect(remote.seen).toHaveLength(1);
      const req = remote.seen[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/search");
      expect(req.headers.authorization).toBe("Bearer sk-test");
      expect(String(req.headers["content-type"])).toMatch(/application\/json/);
      expect(JSON.parse(req.body)).toEqual({
        q: "mcp gateway",
        engine: "default",
        safe: false,
        count: 10, // the declared default, and a number rather than "10"
        detail: "high",
        // recency is absent, not null — the caller passed no recency
      });
    } finally {
      await s.close();
      remote.stop();
    }
  });

  it("narrows the answer to the picked keys", async () => {
    const remote = await api();
    remote.answer(200, { id: "x", created: 1, request_id: "y", results: [{ title: "t" }] });
    const a = new RestAdapter(searchDef(remote.baseUrl), "example");
    await a.build();
    const s = await session(a);
    try {
      expect(await s.call("search", { query: "q" })).toEqual({ results: [{ title: "t" }] });
    } finally {
      await s.close();
      remote.stop();
    }
  });

  it("reports the API's status and body when a call fails", async () => {
    const remote = await api();
    remote.answer(429, { error: { code: "rate_limited", message: "concurrency limit" } });
    const a = new RestAdapter(searchDef(remote.baseUrl), "example");
    await a.build();
    const s = await session(a);
    try {
      await expect(s.callRaw("search", { query: "q" })).rejects.toThrow(/429[\s\S]*rate_limited/);
    } finally {
      await s.close();
      remote.stop();
    }
  });

  it("refuses a call with no required argument, before any request is made", async () => {
    const remote = await api();
    const a = new RestAdapter(searchDef(remote.baseUrl), "example");
    await a.build();
    const s = await session(a);
    try {
      await expect(s.callRaw("search", {})).rejects.toThrow(/query/);
      expect(remote.seen).toHaveLength(0);
    } finally {
      await s.close();
      remote.stop();
    }
  });

  it("rejects a tool it does not declare", async () => {
    const remote = await api();
    const a = new RestAdapter(searchDef(remote.baseUrl), "example");
    await a.build();
    const s = await session(a);
    try {
      await expect(s.callRaw("nope", {})).rejects.toThrow(/unknown tool|nope/i);
    } finally {
      await s.close();
      remote.stop();
    }
  });

  it("renders query parameters and path segments", async () => {
    const remote = await api();
    const def = {
      type: "rest",
      baseUrl: remote.baseUrl,
      tools: [{
        name: "read_file",
        description: "Read a file from a repo.",
        input: {
          owner: { type: "string", required: true },
          repo: { type: "string", required: true },
          ref: { type: "string" },
        },
        request: { method: "GET", path: "/repos/{{owner}}/{{repo}}/file", query: { ref: "{{ref}}", raw: "1" } },
      }],
    };
    const a = new RestAdapter(def, "gh");
    await a.build();
    const s = await session(a);
    try {
      await s.call("read_file", { owner: "an org", repo: "a/b", ref: "main" });
      expect(remote.seen[0].url).toBe("/repos/an%20org/a%2Fb/file?ref=main&raw=1");

      await s.call("read_file", { owner: "o", repo: "r" });
      expect(remote.seen[1].url).toBe("/repos/o/r/file?raw=1"); // no ref passed, so no empty ref sent
    } finally {
      await s.close();
      remote.stop();
    }
  });

  it("sends no body on a GET", async () => {
    const remote = await api();
    const def = {
      type: "rest",
      baseUrl: remote.baseUrl,
      tools: [{ name: "ping_it", description: "p", request: { method: "GET", path: "/ping" } }],
    };
    const a = new RestAdapter(def, "x");
    await a.build();
    const s = await session(a);
    try {
      await s.call("ping_it", {});
      expect(remote.seen[0].body).toBe("");
      expect(remote.seen[0].method).toBe("GET");
    } finally {
      await s.close();
      remote.stop();
    }
  });

  // The registry probes every started MCP every 15s; a declared REST API is as metered as a remote MCP,
  // so this adapter has no ping at all and the registry reports it as unknown rather than paying for it.
  // Asserted through the Adapter interface, which is how the registry reaches for it.
  it("has no health probe", () => {
    const a: Adapter = new RestAdapter({ type: "rest", baseUrl: "https://x.test", tools: [] }, "x");
    expect(a.ping).toBeUndefined();
  });
});
