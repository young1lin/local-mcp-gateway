import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir, dataPath } from "../src/datadir.js";
import { ensureFirstRun } from "../src/bootstrap.js";

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
    // An empty cwd so migration never reads the real repo's .env / config.
    cwd = mkdtempSync(join(tmpdir(), "mcpgw-cwd-"));
    // A home that does not exist yet, so the "created" branch is exercised.
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

  it("creates the data dir, seeds a default config, and generates a token + password", () => {
    const r = ensureFirstRun();
    expect(r.created).toBe(true);
    expect(r.newToken).toBeTruthy();
    expect(r.newPass).toBeTruthy();
    // The seed config is echo-only and boots cleanly.
    const cfg = JSON.parse(readFileSync(join(home, "gateway.config.json"), "utf8"));
    expect(cfg.tokenEnv).toBe("MCP_GATEWAY_TOKEN");
    expect(Object.keys(cfg.servers)).toEqual(["echo"]);
    // The token landed in .env.
    const env = readFileSync(join(home, ".env"), "utf8");
    expect(env).toContain(`MCP_GATEWAY_TOKEN=${r.newToken}`);
    expect(env).toContain(`GATEWAY_PASS=${r.newPass}`);
  });

  it("does not print the token or panel password — points at lmg creds", () => {
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((s) => { lines.push(String(s)); });
    const r = ensureFirstRun();
    const text = lines.join("\n");
    expect(text).toContain("lmg creds");
    expect(text).not.toContain(r.newToken);
    expect(text).not.toContain(r.newPass);
  });

  it("is idempotent — a second run creates nothing new", () => {
    const first = ensureFirstRun();
    const second = ensureFirstRun();
    expect(second.created).toBe(false);
    expect(second.migrated).toBe(false);
    expect(second.newToken).toBeUndefined();
    expect(second.newPass).toBeUndefined();
    // And the first-run token is preserved verbatim.
    expect(readFileSync(join(home, ".env"), "utf8")).toContain(`MCP_GATEWAY_TOKEN=${first.newToken}`);
  });

  it("migrates an existing repo-local .env and keeps its token instead of generating one", () => {
    // Simulate the user's pre-upgrade setup in the cwd.
    writeFileSync(join(cwd, ".env"), "MCP_GATEWAY_TOKEN=their-existing-token\nMYSQL_PASS=x\n");
    const r = ensureFirstRun();
    expect(r.migrated).toBe(true);
    expect(r.newToken).toBeUndefined(); // kept the migrated token, did not regenerate
    const env = readFileSync(join(home, ".env"), "utf8");
    expect(env).toContain("MCP_GATEWAY_TOKEN=their-existing-token");
    expect(env).toContain("MYSQL_PASS=x");
  });

  it("migrates BOTH .env and gateway.config.json — the config copy wins over the seed", () => {
    // A regression guard: `migrateOnce(env) || migrateOnce(cfg)` short-circuits past the config
    // copy, which would then seed an echo-only config and silently drop the user's MCPs.
    writeFileSync(join(cwd, ".env"), "MCP_GATEWAY_TOKEN=tok\n");
    writeFileSync(
      join(cwd, "gateway.config.json"),
      JSON.stringify({ port: 19999, host: "127.0.0.1", tokenEnv: "MCP_GATEWAY_TOKEN", servers: { mysql: { type: "mysql" } } }),
    );
    ensureFirstRun();
    const cfg = JSON.parse(readFileSync(join(home, "gateway.config.json"), "utf8"));
    expect(Object.keys(cfg.servers)).toEqual(["mysql"]); // the user's config, not the echo seed
  });

  it("does not migrate when the data dir already has the file", () => {
    writeFileSync(join(cwd, ".env"), "MCP_GATEWAY_TOKEN=cwd-token\n");
    // A prior run already populated the data dir.
    ensureFirstRun();
    // Now change cwd's .env; a second run must NOT overwrite the data-dir copy.
    writeFileSync(join(cwd, ".env"), "MCP_GATEWAY_TOKEN=different\n");
    ensureFirstRun();
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("MCP_GATEWAY_TOKEN=cwd-token");
  });

  it("seeds a config even when migrating from a cwd that has none", () => {
    // cwd has no gateway.config.json; home is fresh.
    ensureFirstRun();
    expect(existsSync(join(home, "gateway.config.json"))).toBe(true);
  });

  it("seeds MCP_GATEWAY_PORT when that is how the operator chose the listen port", () => {
    process.env.MCP_GATEWAY_PORT = "18000";
    ensureFirstRun();
    const cfg = JSON.parse(readFileSync(join(home, "gateway.config.json"), "utf8"));
    expect(cfg.port).toBe(18000);
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
