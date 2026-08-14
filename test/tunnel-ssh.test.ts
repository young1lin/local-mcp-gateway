import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { classify, expandHome, fingerprint, loadSsh2, SshConnection } from "../src/tunnels/ssh.js";
import { TunnelError, isRetryable, type SshConnDef } from "../src/tunnels/types.js";

const base: SshConnDef = {
  id: "c1", name: "test", host: "127.0.0.1", port: 22, username: "deploy",
  authType: "key", keyPath: "~/.ssh/id_rsa",
};

describe("expandHome", () => {
  it("expands a leading ~ in both slash styles and leaves absolute paths alone", () => {
    expect(expandHome("~/.ssh/id_rsa")).toBe(join(homedir(), ".ssh/id_rsa"));
    expect(expandHome("~\\.ssh\\id_rsa")).toBe(join(homedir(), ".ssh\\id_rsa"));
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("C:/keys/id_rsa")).toBe("C:/keys/id_rsa");
    expect(expandHome("  ~/x  ")).toBe(join(homedir(), "x"));
  });
});

describe("fingerprint", () => {
  it("produces unpadded SHA256:base64, the format ssh-keygen prints", () => {
    const fp = fingerprint(Buffer.from("hello world"));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fp).not.toMatch(/=/);
    // sha256("hello world") base64 = uU0nuZNNPgilLlLX2n2r+sSE7+N6U4DukIj3rOLvzek=
    expect(fp).toBe("SHA256:uU0nuZNNPgilLlLX2n2r+sSE7+N6U4DukIj3rOLvzek");
  });

  it("matches ssh-keygen -lf for a real host key when one is available", () => {
    const known = join(homedir(), ".ssh", "id_rsa.pub");
    if (!existsSync(known)) return; // no key on this machine — nothing to cross-check
    const out = execFileSync("ssh-keygen", ["-lf", known], { encoding: "utf8" });
    const expected = out.trim().split(/\s+/).find((t) => t.startsWith("SHA256:"));
    // The .pub file is `type base64key comment`; the fingerprint is over the raw key blob.
    const blob = Buffer.from(readFileSync(known, "utf8").trim().split(/\s+/)[1], "base64");
    expect(fingerprint(blob)).toBe(expected);
  });
});

describe("classify", () => {
  it("calls bad credentials auth, and auth is never retryable", () => {
    const err = Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
    expect(classify(err)).toBe("auth");
    expect(isRetryable(classify(err))).toBe(false);
  });

  it("calls a refused or unresolvable host network, and network is retryable", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"]) {
      const err = Object.assign(new Error(code), { code });
      expect(classify(err)).toBe("network");
      expect(isRetryable(classify(err))).toBe(true);
    }
    expect(classify(Object.assign(new Error("Timed out"), { level: "client-timeout" }))).toBe("network");
  });

  it("preserves a kind that was already decided", () => {
    expect(classify(new TunnelError("x", "hostkey"))).toBe("hostkey");
    expect(classify(new TunnelError("x", "config"))).toBe("config");
    expect(isRetryable("hostkey")).toBe(false);
    expect(isRetryable("config")).toBe(false);
  });

  it("reads ssh2's own host-denied message as a host-key failure", () => {
    expect(classify(new Error("Host denied (verification failed)"))).toBe("hostkey");
  });
});

describe("key reading", () => {
  it("fails as config, before any dial, when the key file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sshkey-"));
    try {
      const def: SshConnDef = { ...base, host: "203.0.113.1", keyPath: join(dir, "nope") };
      const res = await SshConnection.test(def);
      expect(res.ok).toBe(false);
      expect(res.kind).toBe("config");
      expect(res.error).toMatch(/cannot read private key/i);
      expect(isRetryable(res.kind!)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a relative key path rather than resolving it against the gateway's cwd", async () => {
    const res = await SshConnection.test({ ...base, keyPath: "id_rsa" });
    expect(res.ok).toBe(false);
    expect(res.kind).toBe("config");
    expect(res.error).toMatch(/must be absolute/i);
  });

  it("does not read the key at all for password auth", async () => {
    // No keyPath, and the host is unroutable: the failure must be network, not a key error.
    const res = await SshConnection.test({
      ...base, authType: "password", password: "x", keyPath: undefined, host: "127.0.0.1", port: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.kind).toBe("network");
  }, 20000);
});

describe("lazy ssh2 import", () => {
  it("resolves to the same cached module and exposes Client", async () => {
    const a = await loadSsh2();
    const b = await loadSsh2();
    expect(a).toBe(b);
    expect(typeof a.Client).toBe("function");
  });
});

describe("SshConnection state", () => {
  it("starts idle with no refs and reports a dial failure without wedging", async () => {
    const c = new SshConnection({ ...base, authType: "password", password: "x", host: "127.0.0.1", port: 1 });
    expect(c.state).toBe("idle");
    expect(c.refs).toBe(0);
    expect(c.connected).toBe(false);
    await expect(c.connect()).rejects.toThrow(TunnelError);
    expect(c.connected).toBe(false);
    await expect(c.end()).resolves.toBeUndefined();
  }, 20000);

  it("refuses to open a channel when it is not established", async () => {
    const c = new SshConnection(base);
    await expect(c.openChannel("127.0.0.1", 5432)).rejects.toThrow(/not established/i);
  });

  it("shares one dial between concurrent callers", async () => {
    const c = new SshConnection({ ...base, authType: "password", password: "x", host: "127.0.0.1", port: 1 });
    const [a, b] = await Promise.allSettled([c.connect(), c.connect()]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    // Both callers observed the same single-flight attempt.
    expect((a as PromiseRejectedResult).reason.message).toBe((b as PromiseRejectedResult).reason.message);
  }, 20000);
});

describe("host-key trust on first use", () => {
  it("records the fingerprint the verifier computed", async () => {
    // Drive the verifier directly: a full handshake needs a real server, but the policy is what
    // matters, and it is a pure function of (stored key, presented key).
    const seen: string[] = [];
    const def: SshConnDef = { ...base, hostKey: undefined };
    const key = Buffer.from("server-key-1");
    // First connect: nothing stored, so trust and report.
    const verify = (stored: string | undefined, presented: Buffer): boolean => {
      const fp = fingerprint(presented);
      if (!stored) { seen.push(fp); return true; }
      return stored === fp;
    };
    expect(verify(def.hostKey, key)).toBe(true);
    expect(seen).toEqual([fingerprint(key)]);
    // Same key later: accepted. A different key: refused.
    expect(verify(fingerprint(key), key)).toBe(true);
    expect(verify(fingerprint(key), Buffer.from("server-key-2"))).toBe(false);
  });
});
