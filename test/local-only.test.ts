import { describe, it, expect } from "vitest";
import request from "supertest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/router.js";
import { Registry } from "../src/registry.js";
import { echoAdapter } from "../src/adapters/echo.js";
import { singleTokenManager } from "../src/token.js";
import { isLoopbackBindHost, remoteRequestReason } from "../src/local-only.js";

const TOKEN = "test-token";

async function app() {
  const reg = new Registry(60000);
  reg.register("echo", "config", { type: "echo" }, echoAdapter);
  await reg.start("echo");
  return buildApp(reg, singleTokenManager(TOKEN));
}

describe("isLoopbackBindHost", () => {
  it("accepts the loopback spellings", () => {
    for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "127.0.0.53"]) {
      expect(isLoopbackBindHost(h), h).toBe(true);
    }
  });

  // 0.0.0.0 is the one that looks harmless and is not: it binds every interface, so the gateway
  // becomes reachable from the whole LAN.
  it("rejects every host that is reachable from another machine", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "10.0.0.2", "example.test", ""]) {
      expect(isLoopbackBindHost(h), h).toBe(false);
    }
  });

  it("is not fooled by a hostname that merely starts with a loopback spelling", () => {
    for (const h of ["localhost.evil.test", "127.0.0.1.evil.test"]) {
      expect(isLoopbackBindHost(h), h).toBe(false);
    }
  });
});

describe("remoteRequestReason", () => {
  const req = (headers: Record<string, string>, remoteAddress = "127.0.0.1") =>
    ({ headers, socket: { remoteAddress } }) as never;

  it("passes a loopback request", () => {
    expect(remoteRequestReason(req({ host: "127.0.0.1:19999" }))).toBeUndefined();
    expect(remoteRequestReason(req({ host: "localhost:19999" }))).toBeUndefined();
    expect(remoteRequestReason(req({ host: "[::1]:19999" }, "::1"))).toBeUndefined();
    expect(remoteRequestReason(req({ host: "127.0.0.1:19999", origin: "http://localhost:19999" }))).toBeUndefined();
  });

  // DNS rebinding: the attacker's domain resolves to 127.0.0.1, so the connection IS local and
  // binding to loopback does nothing — the Host header is the only thing that gives it away.
  it("rejects a request whose Host is not loopback", () => {
    expect(remoteRequestReason(req({ host: "evil.test" }))).toMatch(/host/i);
  });

  it("rejects a request carrying a foreign Origin", () => {
    expect(remoteRequestReason(req({ host: "127.0.0.1:19999", origin: "https://evil.test" }))).toMatch(/origin/i);
  });

  it("rejects a peer that is not on this machine", () => {
    expect(remoteRequestReason(req({ host: "127.0.0.1:19999" }, "192.168.1.9"))).toMatch(/address/i);
  });

  it("accepts the IPv4-mapped IPv6 form node reports for a loopback peer", () => {
    expect(remoteRequestReason(req({ host: "127.0.0.1:19999" }, "::ffff:127.0.0.1"))).toBeUndefined();
  });
});

describe("the gateway answers only local requests", () => {
  it("refuses a rebinding attempt on the MCP endpoint even with a valid token", async () => {
    const res = await request(await app())
      .post("/echo")
      .set("Host", "evil.test")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(403);
  });

  // The panel and the health endpoint are not token-gated, so this guard is the only thing standing
  // in front of them.
  it("refuses a rebinding attempt on the panel and on /health", async () => {
    const built = await app();
    expect((await request(built).get("/").set("Host", "evil.test")).status).toBe(403);
    expect((await request(built).get("/health").set("Host", "evil.test")).status).toBe(403);
  });

  it("refuses a page on another origin driving the admin API", async () => {
    const res = await request(await app())
      .post("/api/mcps")
      .set("Origin", "https://evil.test")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ name: "x", command: "node x" });
    expect(res.status).toBe(403);
  });

  it("still serves an ordinary local request", async () => {
    const res = await request(await app()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("loadConfig refuses a non-local bind", () => {
  const write = (host: string) => {
    const dir = mkdtempSync(join(tmpdir(), "mcpgw-bind-"));
    const path = join(dir, "c.json");
    writeFileSync(path, JSON.stringify({ port: 19999, host, tokenEnv: "LOCAL_ONLY_TEST_TOKEN", servers: {} }));
    return path;
  };

  it("throws for a host reachable from another machine", async () => {
    process.env.LOCAL_ONLY_TEST_TOKEN = "t";
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig(write("0.0.0.0"))).toThrow(/local/i);
    expect(() => loadConfig(write("192.168.1.5"))).toThrow(/local/i);
  });

  it("accepts loopback", async () => {
    process.env.LOCAL_ONLY_TEST_TOKEN = "t";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig(write("127.0.0.1")).host).toBe("127.0.0.1");
  });

  // An omitted host used to reach listen() as undefined, which binds every interface — the opposite of
  // what leaving it out looks like it means.
  it("treats an omitted host as loopback rather than as every interface", async () => {
    process.env.LOCAL_ONLY_TEST_TOKEN = "t";
    const dir = mkdtempSync(join(tmpdir(), "mcpgw-bind-"));
    const path = join(dir, "c.json");
    writeFileSync(path, JSON.stringify({ port: 19999, tokenEnv: "LOCAL_ONLY_TEST_TOKEN", servers: {} }));
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig(path).host).toBe("127.0.0.1");
  });
});
