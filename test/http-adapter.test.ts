import { describe, it, expect } from "vitest";
import type { Server as HttpServer } from "node:http";
import { buildApp } from "../src/router.js";
import { Registry } from "../src/registry.js";
import { echoAdapter } from "../src/adapters/echo.js";
import { singleTokenManager } from "../src/token.js";
import { makeAdapter } from "../src/adapters/factory.js";
import { HttpAdapter } from "../src/adapters/http.js";
import { openSession } from "../src/introspect.js";

const TOKEN = "remote-token";

/**
 * The remote MCP server under proxy is the gateway itself, serving the echo MCP over HTTP on an
 * ephemeral loopback port. Two reasons: it needs no network, and its endpoint is bearer-gated — so a
 * proxy that fails to send the configured headers cannot connect at all, which is what makes the
 * "headers reach the remote" assertion honest rather than incidental.
 */
async function remoteEcho() {
  const reg = new Registry(60000);
  reg.register("echo", "config", { type: "echo" }, echoAdapter);
  await reg.start("echo");
  const server: HttpServer = buildApp(reg, singleTokenManager(TOKEN)).listen(0);
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/echo`,
    async stop() {
      server.closeAllConnections?.();
      server.close();
      await reg.closeAll();
    },
  };
}

describe("HttpAdapter proxies a remote streamable-HTTP MCP", () => {
  it("is what the factory builds for type http", () => {
    expect(makeAdapter({ type: "http", url: "https://example.test/mcp" })).toBeInstanceOf(HttpAdapter);
  });

  it("lists the remote's tools through the proxy", async () => {
    const remote = await remoteEcho();
    const adapter = new HttpAdapter({
      name: "r",
      url: remote.url,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    try {
      await adapter.build();
      const client = await openSession(adapter.makeServer());
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(["echo"]);
      await client.close();
    } finally {
      await adapter.close();
      await remote.stop();
    }
  });

  it("fails to connect when the configured headers do not authenticate", async () => {
    const remote = await remoteEcho();
    const adapter = new HttpAdapter({ name: "r", url: remote.url, headers: { Authorization: "Bearer wrong" } });
    try {
      await expect(adapter.build()).rejects.toThrow();
    } finally {
      await adapter.close();
      await remote.stop();
    }
  });

  it("round-trips a tool call to the remote", async () => {
    const remote = await remoteEcho();
    const adapter = new HttpAdapter({ name: "r", url: remote.url, headers: { Authorization: `Bearer ${TOKEN}` } });
    try {
      await adapter.build();
      const client = await openSession(adapter.makeServer());
      const res = await client.callTool({ name: "echo", arguments: { msg: "hi" } });
      expect((res.content as { text: string }[])[0].text).toBe("hi");
      await client.close();
    } finally {
      await adapter.close();
      await remote.stop();
    }
  });

  /**
   * The proxy must advertise what the remote actually negotiated, not a fixed set. echo serves only
   * tools, so announcing resources/prompts would make every client ask for lists that cannot exist —
   * round trips billed by a metered remote for a guaranteed empty answer.
   */
  it("announces only the capabilities the remote has", async () => {
    const remote = await remoteEcho();
    const adapter = new HttpAdapter({ name: "r", url: remote.url, headers: { Authorization: `Bearer ${TOKEN}` } });
    try {
      await adapter.build();
      const client = await openSession(adapter.makeServer());
      const caps = client.getServerCapabilities();
      expect(caps?.tools).toBeDefined();
      expect(caps?.resources).toBeUndefined();
      expect(caps?.prompts).toBeUndefined();
      await client.close();
    } finally {
      await adapter.close();
      await remote.stop();
    }
  });

  /**
   * Health probing must never generate traffic to a remote: the registry probes every started MCP on
   * a 15s timer, which against a metered third-party endpoint would be thousands of unrequested
   * requests a day. So ping() reports whether this MCP is connected and nothing more — it stays
   * resolved even once the remote is gone, and a real failure surfaces on a real call instead.
   */
  it("pings without touching the network", async () => {
    const remote = await remoteEcho();
    const adapter = new HttpAdapter({ name: "r", url: remote.url, headers: { Authorization: `Bearer ${TOKEN}` } });
    await expect(adapter.ping()).rejects.toThrow(/not started/);
    try {
      await adapter.build();
      await remote.stop(); // the remote is now unreachable
      await expect(adapter.ping()).resolves.toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
});
