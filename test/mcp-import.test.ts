import { describe, it, expect } from "vitest";
import { planMcpImport, uniqueName } from "../src/mcp-import.js";

describe("uniqueName", () => {
  it("keeps the name when it is free", () => {
    expect(uniqueName("redis", new Set())).toBe("redis");
  });

  it("appends -1, then -2, when the name is taken", () => {
    expect(uniqueName("redis", new Set(["redis"]))).toBe("redis-1");
    expect(uniqueName("redis", new Set(["redis", "redis-1"]))).toBe("redis-2");
  });

  it("treats reserved path names as taken", () => {
    expect(uniqueName("health", new Set())).toBe("health-1");
    expect(uniqueName("api", new Set())).toBe("api-1");
  });
});

describe("planMcpImport", () => {
  const port = 19999;

  it("turns a stdio entry into a proc MCP, joining command + args", () => {
    const r = planMcpImport({
      mcpServers: {
        files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      },
    }, { taken: new Set(), gatewayPort: port });
    expect(r.skip).toEqual([]);
    expect(r.add).toHaveLength(1);
    expect(r.add[0]).toMatchObject({
      wanted: "files",
      name: "files",
      def: { type: "proc", command: "npx -y @modelcontextprotocol/server-filesystem /tmp" },
    });
  });

  it("quotes args that contain spaces so tokenizeCommand can round-trip them", () => {
    const r = planMcpImport({
      mcpServers: {
        fs: { command: "npx", args: ["-y", "pkg", "C:\\Program Files\\data"] },
      },
    }, { taken: new Set(), gatewayPort: port });
    expect(r.add[0].def.command).toContain('"C:\\Program Files\\data"');
  });

  it("turns an http/sse/remote URL into an http MCP, keeping headers", () => {
    const r = planMcpImport({
      mcpServers: {
        docs: {
          type: "http",
          url: "https://mcp.example/mcp",
          headers: { Authorization: "Bearer ${DOCS_KEY}" },
        },
      },
    }, { taken: new Set(), gatewayPort: port });
    expect(r.add[0].def).toEqual({
      type: "http",
      url: "https://mcp.example/mcp",
      headers: { Authorization: "Bearer ${DOCS_KEY}" },
    });
  });

  it("skips a URL that already points at this gateway", () => {
    const r = planMcpImport({
      mcpServers: {
        redis: { url: "http://127.0.0.1:19999/redis", headers: { Authorization: "Bearer x" } },
        other: { url: "http://localhost:19999/mysql" },
        keep: { url: "http://127.0.0.1:3000/mcp" },
      },
    }, { taken: new Set(), gatewayPort: port });
    expect(r.skip.map((s) => s.name).sort()).toEqual(["other", "redis"]);
    expect(r.add.map((a) => a.name)).toEqual(["keep"]);
  });

  it("renames collisions instead of overwriting — redis, then redis-1, redis-2", () => {
    const r = planMcpImport({
      mcpServers: {
        redis: { command: "npx", args: ["a"] },
        extra: { command: "npx", args: ["b"] },
      },
    }, { taken: new Set(["redis"]), gatewayPort: port });
    expect(r.add.map((a) => a.name).sort()).toEqual(["extra", "redis-1"]);
  });

  it("two entries that sanitize to the same name get -1 on the second", () => {
    const r = planMcpImport({
      mcpServers: {
        Redis: { command: "npx", args: ["a"] },
        redis: { command: "npx", args: ["b"] },
      },
    }, { taken: new Set(), gatewayPort: port });
    const names = r.add.map((a) => a.name);
    expect(names).toContain("redis");
    expect(names).toContain("redis-1");
  });

  it("accepts Cursor's servers key and a bare name map", () => {
    const viaServers = planMcpImport({
      servers: { a: { command: "npx", args: ["x"] } },
    }, { taken: new Set(), gatewayPort: port });
    expect(viaServers.add[0].name).toBe("a");

    const bare = planMcpImport({
      b: { url: "https://example.test/mcp" },
    }, { taken: new Set(), gatewayPort: port });
    expect(bare.add[0].name).toBe("b");
  });

  it("skips an entry that has neither command nor url", () => {
    const r = planMcpImport({
      mcpServers: { broken: { type: "stdio" } },
    }, { taken: new Set(), gatewayPort: port });
    expect(r.add).toEqual([]);
    expect(r.skip[0]).toMatchObject({ name: "broken" });
  });

  it("carries proc env and cwd through", () => {
    const r = planMcpImport({
      mcpServers: {
        x: { command: "node", args: ["s.js"], env: { FOO: "1" }, cwd: "/tmp" },
      },
    }, { taken: new Set(), gatewayPort: port });
    expect(r.add[0].def).toMatchObject({ type: "proc", env: { FOO: "1" }, cwd: "/tmp" });
  });
});
