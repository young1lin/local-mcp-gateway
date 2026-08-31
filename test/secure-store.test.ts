import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, unseal, isSealed } from "../src/secure/envelope.js";
import {
  deriveMachineKey, masterKeyCandidates, parseKeyHex, parseMachineGuid, parsePlatformUuid,
  MASTER_KEY_ENV,
} from "../src/secure/key.js";
import { readSecureJson, writeSecureJson } from "../src/secure/statefile.js";
import { injectEnvStore, parseEnvText, readEnvStore, setEnvDefault, writeEnvStore } from "../src/secure/envstore.js";

// The suite pins MCP_GATEWAY_MASTER_KEY in setup.ts, so "this machine" is a fixed key and no test
// ever spawns powershell / security / secret-tool. The "other machine" cases seal with a key that
// is deliberately NOT the pinned one and prove the file refuses to open.

let dir: string;
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sec-"));
  prevHome = process.env.MCP_GATEWAY_HOME;
  home = mkdtempSync(join(tmpdir(), "sec-home-"));
  process.env.MCP_GATEWAY_HOME = home;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.MCP_GATEWAY_HOME;
  else process.env.MCP_GATEWAY_HOME = prevHome;
});

describe("envelope", () => {
  const key = Buffer.from("11".repeat(32), "hex");

  it("round-trips, and refuses a wrong key or a tampered byte", () => {
    const s = seal(key, "test", JSON.stringify({ a: 1 }));
    expect(unseal(key, s)).toBe(JSON.stringify({ a: 1 }));
    expect(() => unseal(Buffer.from("22".repeat(32), "hex"), s)).toThrow();
    const tampered = { ...s, ct: (s.ct[0] === "A" ? "B" : "A") + s.ct.slice(1) };
    expect(() => unseal(key, tampered)).toThrow();
  });

  it("isSealed recognizes envelopes and rejects user-authored objects", () => {
    expect(isSealed(seal(key, "t", "x"))).toBe(true);
    expect(isSealed({ port: 1, servers: {} })).toBe(false);
    expect(isSealed(null)).toBe(false);
    expect(isSealed([1, 2])).toBe(false);
  });
});

describe("machine key", () => {
  it("parses hex strictly — a misconfigured key fails loudly", () => {
    expect(parseKeyHex("ab".repeat(32), "x")).toHaveLength(32);
    expect(() => parseKeyHex("zz".repeat(32), "x")).toThrow(/64 hex/);
    expect(() => parseKeyHex("ab", "x")).toThrow(/64 hex/);
  });

  it("derives a stable per-machine key that differs per machine id", () => {
    expect(deriveMachineKey("machine-1")).toEqual(deriveMachineKey("machine-1"));
    expect(deriveMachineKey("machine-1")).not.toEqual(deriveMachineKey("machine-2"));
    expect(deriveMachineKey("machine-1")).toHaveLength(32);
  });

  it("parses MachineGuid and IOPlatformUUID helper output", () => {
    const reg = "\r\nHKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography\r\n    MachineGuid    REG_SZ    1234-abcd\r\n";
    expect(parseMachineGuid(reg)).toBe("1234-abcd");
    expect(parseMachineGuid("no guid here")).toBeUndefined();
    const ioreg = '"+-o IOPlatformExpertDevice\n  "IOPlatformUUID" = "UUID-9"';
    expect(parsePlatformUuid(ioreg)).toBe("UUID-9");
  });

  it("resolves to the pinned env key without spawning anything", () => {
    const cands = masterKeyCandidates();
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe("env");
    expect(cands[0].key).toEqual(Buffer.from("ab".repeat(32), "hex"));
  });

  it("refuses a malformed MCP_GATEWAY_MASTER_KEY", () => {
    const prev = process.env[MASTER_KEY_ENV];
    process.env[MASTER_KEY_ENV] = "not-hex";
    try {
      expect(() => masterKeyCandidates()).toThrow(/64 hex/);
    } finally {
      process.env[MASTER_KEY_ENV] = prev;
    }
  });
});

describe("sealed state files", () => {
  it("writes ciphertext only — no secret substring ever reaches the disk", () => {
    const p = join(dir, "managed.json");
    writeSecureJson(p, { mcps: [{ name: "mysql", def: { type: "mysql", password: "hunter2-supersecret" } }] });
    const raw = readFileSync(p, "utf8");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain('"lmg": 1');
    expect(readSecureJson(p)).toMatchObject({ mcps: [{ name: "mysql" }] });
  });

  it("migrates a plaintext file to sealed on first read — boot once and it is gone", () => {
    const p = join(dir, "gateway.config.json");
    writeFileSync(p, JSON.stringify({ tokenEnv: "X", servers: { a: { type: "echo", password: "plain-pass-9" } } }));
    const v = readSecureJson<Record<string, any>>(p)!;
    expect(v.servers.a.password).toBe("plain-pass-9");
    const raw = readFileSync(p, "utf8");
    expect(raw).not.toContain("plain-pass-9");
    expect(raw).toContain('"lmg": 1');
    expect(readSecureJson<Record<string, any>>(p)!.servers.a.password).toBe("plain-pass-9");
  });

  it("refuses a file sealed on ANOTHER machine — the anti-copy property", () => {
    const otherMachine = Buffer.from("99".repeat(32), "hex");
    const p = join(dir, "tunnels.json");
    writeFileSync(p, JSON.stringify(seal(otherMachine, "dpapi", JSON.stringify({ password: "ssh-secret" }))));
    expect(() => readSecureJson(p)).toThrow(/cannot decrypt/);
  });

  it("answers undefined for a missing file instead of throwing", () => {
    expect(readSecureJson(join(dir, "nope.json"))).toBeUndefined();
  });
});

describe("sealed env store (the .env replacement)", () => {
  it("parses .env text the way dotenv would: export, quotes, comments", () => {
    expect(parseEnvText("# comment\nA=1\nexport B=two\nC=\"quoted val\"\nD='single'\nbroken-line\n")).toEqual({
      A: "1",
      B: "two",
      C: "quoted val",
      D: "single",
    });
  });

  it("consumes a legacy plaintext .env: merged, sealed, verified, then deleted", () => {
    writeFileSync(join(home, ".env"), "MCP_GATEWAY_TOKEN=tok-1\nDB_PASS=pp\n");
    const store = readEnvStore();
    expect(store).toMatchObject({ MCP_GATEWAY_TOKEN: "tok-1", DB_PASS: "pp" });
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(readFileSync(join(home, "env.json"), "utf8")).not.toContain("tok-1");
    expect(readEnvStore()).toMatchObject({ DB_PASS: "pp" });
  });

  it("setEnvDefault writes only what is missing; injectEnvStore never overrides the OS env", () => {
    expect(setEnvDefault("LMG_TEST_KEY", "first")).toBe(true);
    expect(setEnvDefault("LMG_TEST_KEY", "second")).toBe(false);
    expect(readEnvStore()["LMG_TEST_KEY"]).toBe("first");
    process.env.LMG_TEST_KEY = "from-os";
    injectEnvStore();
    expect(process.env.LMG_TEST_KEY).toBe("from-os");
    delete process.env.LMG_TEST_KEY;
    injectEnvStore();
    expect(process.env.LMG_TEST_KEY).toBe("first");
    delete process.env.LMG_TEST_KEY;
  });
});

describe("loadConfig over sealed state", () => {
  it("reads a sealed config and resolves refs from the sealed env store at build time", async () => {
    writeEnvStore({ MCP_GATEWAY_TOKEN: "tok-9", MYSQL_PASS: "mpass-9" });
    delete process.env.MCP_GATEWAY_TOKEN;
    delete process.env.MYSQL_PASS;
    const p = join(dir, "c.json");
    writeSecureJson(p, {
      port: 19999,
      host: "127.0.0.1",
      tokenEnv: "MCP_GATEWAY_TOKEN",
      servers: { mysql: { type: "mysql", password: "${MYSQL_PASS}" } },
    });
    const { loadConfig, resolveDef } = await import("../src/config.js");
    const cfg = loadConfig(p);
    expect(cfg.token).toBe("tok-9");
    expect((cfg.servers.mysql as Record<string, unknown>).password).toBe("${MYSQL_PASS}"); // a ref at rest
    expect((resolveDef(cfg.servers.mysql) as Record<string, unknown>).password).toBe("mpass-9"); // real only at build
    delete process.env.MYSQL_PASS;
    delete process.env.MCP_GATEWAY_TOKEN;
  });
});

describe("export / import (the recovery path)", () => {
  it("round-trips a whole install into a fresh data dir, re-sealed", async () => {
    const { exportState, importState, readGatewayToken } = await import("../src/daemon.js");
    writeEnvStore({ MCP_GATEWAY_TOKEN: "tok-export" });
    writeSecureJson(join(home, "gateway.config.json"), {
      port: 19999, host: "127.0.0.1", tokenEnv: "MCP_GATEWAY_TOKEN",
      servers: { echo: { type: "echo" } },
    });
    writeSecureJson(join(home, "managed.json"), { mcps: [{ name: "m", def: { type: "echo" }, enabled: true }] });

    const bundle = exportState();
    expect(bundle.config).toMatchObject({ port: 19999 });
    expect(bundle.env).toMatchObject({ MCP_GATEWAY_TOKEN: "tok-export" });
    expect(readGatewayToken()).toBe("tok-export");

    // The "new machine": a fresh data dir. The bundle restores and everything reads back.
    const fresh = mkdtempSync(join(tmpdir(), "sec-home2-"));
    process.env.MCP_GATEWAY_HOME = fresh;
    try {
      const restored = importState(bundle);
      expect(restored).toContain("gateway.config.json");
      expect(restored).toContain("env.json");
      expect(readSecureJson<Record<string, any>>(join(fresh, "gateway.config.json"))).toMatchObject({ port: 19999 });
      expect(readGatewayToken()).toBe("tok-export");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
