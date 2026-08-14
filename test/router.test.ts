import { describe, it, expect } from "vitest";
import request from "supertest";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildApp } from "../src/router.js";
import { Registry } from "../src/registry.js";
import { echoAdapter } from "../src/adapters/echo.js";
import { singleTokenManager } from "../src/token.js";

const TOKEN = "test-token";
const ACCEPT = "application/json, text/event-stream";

function mcp(method: string, params: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

// The SDK answers a POST with an SSE "data:" stream (and leaves supertest's
// res.body empty for text/event-stream). Parse the SSE data line; fall back to JSON body/text.
function parseMcp(res: request.Response): any {
  if (res.body && typeof res.body === "object" && Object.keys(res.body).length > 0) return res.body;
  const text = res.text as string;
  const m = text.match(/data:\s*(\{[\s\S]*\})/);
  return JSON.parse(m ? m[1] : text);
}

async function echoRegistry(): Promise<Registry> {
  const reg = new Registry(60000);
  reg.register("echo", "config", { type: "echo" }, echoAdapter);
  await reg.start("echo");
  return reg;
}

describe("router plumbing (echo adapter)", () => {
  it("rejects request without bearer token", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    const res = await request(app).post("/echo").set("Accept", ACCEPT).send(mcp("initialize"));
    expect(res.status).toBe(401);
  });

  it("initializes, lists tools, and calls echo", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    const auth = { Authorization: `Bearer ${TOKEN}` };

    const init = await request(app).post("/echo").set(auth).set("Accept", ACCEPT)
      .send(mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    expect(init.status).toBe(200);

    const list = await request(app).post("/echo").set(auth).set("Accept", ACCEPT).send(mcp("tools/list"));
    expect(list.status).toBe(200);
    const names = (parseMcp(list).result?.tools ?? []).map((t: any) => t.name);
    expect(names).toContain("echo");

    const call = await request(app).post("/echo").set(auth).set("Accept", ACCEPT)
      .send(mcp("tools/call", { name: "echo", arguments: { msg: "hi" } }));
    expect(call.status).toBe(200);
    expect(parseMcp(call).result?.content?.[0]?.text).toBe("hi");
  });

  it("returns 503 for an unknown path", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    const res = await request(app).post("/nope").set("Authorization", `Bearer ${TOKEN}`).send(mcp("tools/list"));
    expect(res.status).toBe(503);
  });

  it("returns 503 when the MCP is stopped", async () => {
    const reg = await echoRegistry();
    await reg.stop("echo");
    const app = buildApp(reg, singleTokenManager(TOKEN));
    const res = await request(app).post("/echo").set("Authorization", `Bearer ${TOKEN}`).send(mcp("tools/list"));
    expect(res.status).toBe(503);
  });

  it("reports health and configured paths", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.paths).toBeUndefined();
    expect(res.body.health).toBeUndefined();
  });

  it("serves the management dashboard at /", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("MCP Gateway");
  });

  // On the 2026-07-28 protocol the gateway serves notifications through the client's subscriptions/listen
  // POST stream, not a standalone GET SSE stream, so GET /:path is not served and falls through to 404.
  // (A 2025-era client that opened a GET notification stream is no longer supported.)
  it("GET /:path is not served — notifications go via subscriptions/listen, not a GET stream", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    const res = await request(app).get("/echo").set("Authorization", `Bearer ${TOKEN}`).set("Accept", "text/event-stream");
    expect(res.status).toBe(404);
  });

  it("DELETE returns 204 (stateless teardown no-op)", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    const res = await request(app).delete("/echo").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(204);
  });

  // Regression: clients fire concurrent requests (tools/list + tools/call together). A shared
  // Server binds one transport, so concurrent connect() calls raced and misrouted one response
  // → the other hung until the client timed out ("tools fetch failed"). Fresh server per request
  // wraps the shared child client, which multiplexes by JSON-RPC id.
  it("handles concurrent requests without hanging (fresh server per request)", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const [r1, r2] = await Promise.all([
      request(app).post("/echo").set(auth).set("Accept", ACCEPT).send(mcp("tools/list", {}, 10)),
      request(app).post("/echo").set(auth).set("Accept", ACCEPT).send(mcp("tools/call", { name: "echo", arguments: { msg: "concurrent" } }, 11)),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(parseMcp(r1).result?.tools?.length).toBe(1);
    expect(parseMcp(r2).result?.content?.[0]?.text).toBe("concurrent");
  });
});

describe("http.ts behaviours express used to provide", () => {
  it("answers HEAD on a registered GET route", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    const res = await request(app).head("/health");
    // express auto-maps HEAD to the GET handler: headers, empty body. A hard 404 breaks `curl -I`
    // and any uptime probe pointed at the dashboard.
    expect(res.status).toBe(200);
  });

  it("still 404s HEAD on a path with no route", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    expect((await request(app).head("/nothing-here/deep/path")).status).toBe(404);
  });

});

describe("2026-07-28 server/discover (modern era)", () => {
  // The capability probe a modern client sends before falling back to initialize. On the v1 SDK this
  // returned method-not-found and surfaced as an error in the traffic log; createMcpHandler answers
  // it natively with a DiscoverResult. This is the whole reason the SDK was upgraded.
  const discover = {
    jsonrpc: "2.0",
    id: "discover-1",
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "ExampleClient", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };

  it("answers server/discover with a DiscoverResult (not method-not-found)", async () => {
    const app = buildApp(await echoRegistry(), singleTokenManager(TOKEN));
    const res = await request(app).post("/echo")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Accept", ACCEPT)
      // The SDK client derives these from the body envelope (MCP-Protocol-Version, Mcp-Method); the
      // gateway's era classifier cross-checks them, so a canonical probe carries both.
      .set("MCP-Protocol-Version", "2026-07-28")
      .set("Mcp-Method", "server/discover")
      .send(discover);
    expect(res.status).toBe(200);
    const body = parseMcp(res);
    expect(body.error).toBeUndefined();
    expect(body.result?.supportedVersions).toContain("2026-07-28");
    expect(body.result?.capabilities).toBeDefined();
  });

  // A real v2 SDK client connecting over HTTP, pinned to the 2026-07-28 era. The pin forces
  // connect() to probe server/discover; if the gateway did not answer it (the old bug), the pin
  // could not be satisfied and connect() would reject with an era-negotiation error. A successful
  // connect + tools/list is end-to-end proof that discover is served and modern requests work.
  it("a real SDK client negotiates the modern era and lists tools", async () => {
    const reg = await echoRegistry();
    const app = buildApp(reg, singleTokenManager(TOKEN));
    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/echo`;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      });
      const client = new Client(
        { name: "test-client", version: "1.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(transport); // rejects if server/discover is not answered
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("echo");
      await client.close();
    } finally {
      server.closeAllConnections?.();
      server.close();
      await reg.closeAll();
    }
  });
});
