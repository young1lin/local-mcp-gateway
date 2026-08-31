import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir, dataPath } from "../src/datadir.js";
import { ensureFirstRun } from "../src/bootstrap.js";
import { readSecureJson } from "../src/secure/statefile.js";
import { readEnvStore } from "../src/secure/envstore.js";

describe("dataDir / dataPath", () => {
  afterEach(() => {
    delete process.env.MCP_GATEWAY_HOME;
  });

  it("uses MCP_GATEWAY_HOME when set", () => {
    const home = mkdtempSync(join(tmpdir(), "mcpgw-home-"));
    process.env.MCP_GATEWAY_HOME = home;
    expect(dataDir()).toBe(home);
    expect(dataPath("managed.json")).toBe(join(home, "managed.json"));
  });

  it("falls back to ~/.mcp-gateway when unset", () => {
    delete process.env.MCP_GATEWAY_HOME;
    expect(dataDir()).toBe(join(homedir(), ".mcp-gateway"));
  });
});

describe("ensureFirstRun", () => {
  let origCwd: string;
  let cwd: string;
  let home: string;

  beforeEach(() => {
    origCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "mcpgw-cwd-"));
    home = join(mkdtempSync(join(tmpdir(), "mcpgw-parent-")), "new-home");
    process.chdir(cwd);
    process.env.MCP_GATEWAY_HOME = home;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(origCwd);
    delete process.env.MCP_GATEWAY_HOME;
    delete process.env.MCP_GATEWAY_PORT;
    vi.restoreAllMocks();
  });

  it("creates the data dir, seeds a SEALED config, and puts the token in the sealed env store", () => {
    const r = ensureFirstRun();
    expect(r.created).toBe(true);
    expect(r.newToken).toBeTruthy();
    const cfg = readSecureJson<Record<string, any>>(join(home, "gateway.config.json"))!;
    expect(cfg.tokenEnv).toBe("MCP_GATEWAY_TOKEN");
    expect(Object.keys(cfg.servers)).toEqual(["echo"]);
    expect(readEnvStore()["MCP_GATEWAY_TOKEN"]).toBe(r.newToken);
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(readFileSync(join(home, "gateway.config.json"), "utf8")).not.toContain("tokenEnv");
  });

  it("does not print the token — points at lmg creds", () => {
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((s) => { lines.push(String(s)); });
    const r = ensureFirstRun();
    const text = lines.join("\n");
    expect(text).toContain("lmg creds");
    expect(text).not.toContain(r.newToken ?? "<no token>");
  });

  it("is idempotent — a second run creates nothing new", () => {
    const first = ensureFirstRun();
    const second = ensureFirstRun();
    expect(second.created).toBe(false);
    expect(second.migrated).toBe(false);
    expect(second.newToken).toBeUndefined();
    expect(readEnvStore()["MCP_GATEWAY_TOKEN"]).toBe(first.newToken);
  });

  it("migrates a repo-local .env INTO the sealed store — no plaintext copy, token kept", () => {
    writeFileSync(join(cwd, ".env"), "MCP_GATEWAY_TOKEN=their-existing-token\nMYSQL_PASS=x\n");
    const r = ensureFirstRun();
    expect(r.migrated).toBe(true);
    expect(r.newToken).toBeUndefined();
    const store = readEnvStore();
    expect(store["MCP_GATEWAY_TOKEN"]).toBe("their-existing-token");
    expect(store["MYSQL_PASS"]).toBe("x");
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("migrates BOTH .env and gateway.config.json — the config wins over the seed", () => {
    writeFileSync(join(cwd, ".env"), "MCP_GATEWAY_TOKEN=tok\n");
    writeFileSync(
      join(cwd, "gateway.config.json"),
      JSON.stringify({ port: 19999, host: "127.0.0.1", tokenEnv: "MCP_GATEWAY_TOKEN", servers: { mysql: { type: "mysql" } } }),
    );
    ensureFirstRun();
    const cfg = readSecureJson<Record<string, any>>(join(home, "gateway.config.json"))!;
    expect(Object.keys(cfg.servers)).toEqual(["mysql"]);
  });

  it("does not migrate when the data dir already has the state", () => {
    writeFileSync(join(cwd, ".env"), "MCP_GATEWAY_TOKEN=cwd-token\n");
    ensureFirstRun();
    writeFileSync(join(cwd, ".env"), "MCP_GATEWAY_TOKEN=different\n");
    ensureFirstRun();
    expect(readEnvStore()["MCP_GATEWAY_TOKEN"]).toBe("cwd-token");
  });

  it("seeds a config even when migrating from a cwd that has none", () => {
    ensureFirstRun();
    expect(existsSync(join(home, "gateway.config.json"))).toBe(true);
  });

  it("seeds MCP_GATEWAY_PORT when that is how the operator chose the listen port", () => {
    process.env.MCP_GATEWAY_PORT = "18000";
    ensureFirstRun();
    expect(readSecureJson<Record<string, any>>(join(home, "gateway.config.json"))!.port).toBe(18000);
  });

  it("prints the panel url for the configured port, not a hardcoded 19999", () => {
    writeFileSync(join(cwd, ".env"), "MCP_GATEWAY_TOKEN=tok\n");
    writeFileSync(
      join(cwd, "gateway.config.json"),
      JSON.stringify({ port: 18000, host: "127.0.0.1", tokenEnv: "MCP_GATEWAY_TOKEN", servers: { echo: { type: "echo" } } }),
    );
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((s) => { lines.push(String(s)); });
    ensureFirstRun();
    const text = lines.join("\n");
    expect(text).toContain("http://127.0.0.1:18000/");
    expect(text).not.toContain("19999");
  });
});
