import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcpgw-"));
    // isolate env
    for (const k of ["MCP_GATEWAY_TOKEN", "MYSQL_PASS", "REDIS_URL", "MCP_GATEWAY_PORT"]) delete process.env[k];
  });

  function writeConfig(): string {
    writeFileSync(
      join(dir, "c.json"),
      JSON.stringify({
        port: 19999, host: "127.0.0.1", tokenEnv: "MCP_GATEWAY_TOKEN",
        servers: {
          mysql: { type: "mysql", env: { MYSQL_PASS: "${MYSQL_PASS}", MYSQL_DB: "app" } },
          "redis-a-6379": { type: "redis", url: "${REDIS_URL}", permissions: ["read"] },
        },
      })
    );
    return join(dir, "c.json");
  }

  /** A config carrying only what the test cares about, so the port can be absent or wrong. */
  function writePort(port: unknown): string {
    const path = join(dir, "p.json");
    const raw: Record<string, unknown> = { host: "127.0.0.1", tokenEnv: "MCP_GATEWAY_TOKEN", servers: {} };
    if (port !== undefined) raw.port = port;
    writeFileSync(path, JSON.stringify(raw));
    return path;
  }

  // A missing port used to reach listen() as undefined, which binds an arbitrary free port: the
  // gateway came up "fine" on an address no client was configured for.
  it("defaults the port to 19999 and takes a configured one", async () => {
    process.env.MCP_GATEWAY_TOKEN = "tok";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig(writePort(undefined)).port).toBe(19999);
    expect(loadConfig(writePort(28080)).port).toBe(28080);
  });

  it("lets MCP_GATEWAY_PORT override the file, so lmg start --port actually listens there", async () => {
    process.env.MCP_GATEWAY_TOKEN = "tok";
    process.env.MCP_GATEWAY_PORT = "18000";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig(writePort(19999)).port).toBe(18000);
    delete process.env.MCP_GATEWAY_PORT;
  });

  it("refuses a port that is not a usable one", async () => {
    process.env.MCP_GATEWAY_TOKEN = "tok";
    const { loadConfig } = await import("../src/config.js");
    for (const bad of [0, -1, 70000, 1.5, "8080", null]) {
      expect(() => loadConfig(writePort(bad)), String(bad)).toThrow(/port/i);
    }
  });

  // Deliberate: definitions stay unresolved so nothing downstream (the panel, a managed.json
  // override) can write a live credential to disk. resolveDef() expands them at adapter build.
  it("keeps ${} placeholders in server defs and resolves the token", async () => {
    process.env.MCP_GATEWAY_TOKEN = "tok";
    process.env.MYSQL_PASS = "secret";
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig(writeConfig());
    expect(cfg.token).toBe("tok");
    expect((cfg.servers["mysql"] as any).env.MYSQL_PASS).toBe("${MYSQL_PASS}");
    expect((cfg.servers["mysql"] as any).env.MYSQL_DB).toBe("app");
  });

  it("resolveDef expands placeholders, including nested objects and arrays", async () => {
    process.env.MCP_GATEWAY_TOKEN = "tok";
    process.env.MYSQL_PASS = "secret";
    process.env.REDIS_URL = "redis://x:6379/0";
    const { loadConfig, resolveDef } = await import("../src/config.js");
    const cfg = loadConfig(writeConfig());

    const mysql = resolveDef(cfg.servers["mysql"]) as any;
    expect(mysql.env.MYSQL_PASS).toBe("secret");
    expect(mysql.env.MYSQL_DB).toBe("app");

    const redis = resolveDef(cfg.servers["redis-a-6379"]) as any;
    expect(redis.url).toBe("redis://x:6379/0");
    expect(redis.permissions).toEqual(["read"]);
    expect(Array.isArray(redis.permissions)).toBe(true);
  });

  it("isEnvRef only matches a bare ${VAR} reference", async () => {
    const { isEnvRef } = await import("../src/config.js");
    expect(isEnvRef("${MYSQL_PASS}")).toBe(true);
    expect(isEnvRef("prefix-${VAR}")).toBe(false);
    expect(isEnvRef("hunter2")).toBe(false);
    expect(isEnvRef(42)).toBe(false);
  });

  it("throws when token env var is missing", async () => {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ port: 1, host: "127.0.0.1", tokenEnv: "MCP_GATEWAY_TOKEN_NEVER_SET", servers: {} }));
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig(join(dir, "c.json"))).toThrow(/token/i);
  });
});

/**
 * The example config is a user-facing artifact — it is what a new install copies — so a stale `type`
 * or a field the adapter no longer reads is a broken first run. Constructing the adapters is enough
 * to catch that: no adapter connects in its constructor, so this stays offline.
 */
describe("gateway.config.example.json", () => {
  it("builds an adapter for every server it defines", async () => {
    const { makeAdapter } = await import("../src/adapters/factory.js");
    const raw = JSON.parse(readFileSync("gateway.config.example.json", "utf8"));
    const names = Object.keys(raw.servers);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(() => makeAdapter(raw.servers[name], name), name).not.toThrow();
    }
  });

  it("binds to loopback", () => {
    const raw = JSON.parse(readFileSync("gateway.config.example.json", "utf8"));
    expect(raw.host).toBe("127.0.0.1");
  });
});
