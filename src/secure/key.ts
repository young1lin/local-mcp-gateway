import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "../datadir.js";

/**
 * The machine-bound master key every state file is sealed with (see statefile.ts).
 *
 * Where the key lives, per platform - always the OS credential store first, because that is the
 * one place the OS itself keeps secrets at rest:
 *
 *   Windows  DPAPI (CurrentUser). A random key is generated once, protected by DPAPI, and the
 *            protected blob sits in the data dir as 'master.key'. On any other machine or under
 *            any other user the blob is opaque - which is exactly the anti-copy property.
 *   macOS    the login Keychain, via the shipped 'security' CLI.
 *   Linux    the Secret Service (libsecret) via 'secret-tool' when a session daemon exists;
 *            headless boxes fall back to the machine id.
 *   fallback the machine id (MachineGuid / IOPlatformUUID / /etc/machine-id), hashed. World-readable
 *            on Linux, so it binds to the MACHINE, not the user - still enough to make a copied
 *            data dir useless elsewhere.
 *
 * An explicit MCP_GATEWAY_MASTER_KEY (64 hex chars) overrides every source - for CI, containers
 * and recovery, and what the test suite uses so it never spawns a single OS helper.
 *
 * The key is resolved at most once per process and cached; acquiring it may spawn one short-lived
 * helper (powershell / security / secret-tool / reg / ioreg), which is the entire cost.
 */

export const MASTER_KEY_ENV = "MCP_GATEWAY_MASTER_KEY";

/** One way to obtain the master key. 'id' is recorded inside every sealed file for diagnostics. */
interface KeySource {
  id: string;
  /** The 32-byte master key. Throws when this source cannot produce one. */
  get(): Buffer;
}

const KEY_LEN = 32;
/** Domain separation: the app string is also the DPAPI entropy, so a blob is ours or nobody's. */
const APP = "local-mcp-gateway/v1";
/** The Keychain / Secret Service names under which the master key is filed. */
const SERVICE = "local-mcp-gateway";
const ACCOUNT = "master";

/** Run one helper and capture stdout, or throw. Never lets stderr or a prompt reach the user. */
function sh(cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, {
    input,
    encoding: "utf8",
    stdio: input === undefined ? ["ignore", "pipe", "ignore"] : ["pipe", "pipe", "ignore"],
    timeout: 15_000,
    windowsHide: true,
  }).trim();
}

/** Accept only a full 64-hex-char key - anything else is a misconfiguration, not a key. */
export function parseKeyHex(raw: string, what: string): Buffer {
  const hex = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(what + " must be 64 hex chars (32 bytes), got " + hex.length + " chars");
  }
  return Buffer.from(hex, "hex");
}

// --- Windows: DPAPI -----------------------------------------------------------------------------

/** Protect/unprotect one base64 blob through PowerShell's System.Security assembly. */
function dpapi(b64: string, protect: boolean): string {
  const verb = protect ? "Protect" : "Unprotect";
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$blob = [Security.Cryptography.ProtectedData]::" + verb +
      "([Convert]::FromBase64String('" + b64 + "'), [Text.Encoding]::UTF8.GetBytes('" + APP + "'), 'CurrentUser')",
    "[Convert]::ToBase64String($blob)",
  ].join("; ");
  return sh("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

function dpapiSource(): KeySource {
  return {
    id: "dpapi",
    get(): Buffer {
      const path = dataPath("master.key");
      if (existsSync(path)) {
        // Unprotect throws when this user on this machine is not the one who protected it -
        // the caller drops the source and the fallback (or a clear error) takes over.
        const key = Buffer.from(dpapi(readFileSync(path, "utf8").trim(), false), "base64");
        if (key.length !== KEY_LEN) throw new Error("master.key holds a malformed key");
        return key;
      }
      const key = randomBytes(KEY_LEN);
      writeFileSync(path, dpapi(key.toString("base64"), true), { mode: 0o600 });
      chmodSync(path, 0o600);
      return key;
    },
  };
}

// --- macOS: login Keychain ----------------------------------------------------------------------

function keychainSource(): KeySource {
  return {
    id: "keychain",
    get(): Buffer {
      try {
        return parseKeyHex(sh("security", ["find-generic-password", "-w", "-s", SERVICE, "-a", ACCOUNT]), "macOS Keychain");
      } catch {
        /* not stored yet - create it below */
      }
      const key = randomBytes(KEY_LEN);
      // -U: add-or-update, so a half-written earlier entry cannot wedge the store.
      sh("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", key.toString("hex")]);
      return key;
    },
  };
}

// --- Linux: Secret Service ----------------------------------------------------------------------

function secretToolSource(): KeySource {
  return {
    id: "secrettool",
    get(): Buffer {
      try {
        return parseKeyHex(sh("secret-tool", ["lookup", "lmg", ACCOUNT]), "Secret Service");
      } catch {
        /* absent, or no session daemon running */
      }
      const key = randomBytes(KEY_LEN);
      sh("secret-tool", ["store", "--label=" + SERVICE, "lmg", ACCOUNT], key.toString("hex"));
      return key;
    },
  };
}

// --- fallback: the machine id -------------------------------------------------------------------

/** sha256(APP + NUL + machineId) - stable per machine, useless off it. */
export function deriveMachineKey(machineId: string): Buffer {
  return createHash("sha256").update(APP).update(String.fromCharCode(0)).update(machineId).digest();
}

/** 'reg query' output -> the MachineGuid value, or undefined. */
export function parseMachineGuid(regOutput: string): string | undefined {
  return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(regOutput)?.[1];
}

/** 'ioreg' output -> the IOPlatformUUID value, or undefined. */
export function parsePlatformUuid(ioregOutput: string): string | undefined {
  return /IOPlatformUUID"?\s*=\s*"?([^"\s]+)/.exec(ioregOutput)?.[1];
}

function machineIdSource(): KeySource {
  return {
    id: "machineid",
    get(): Buffer {
      if (process.platform === "win32") {
        const id = parseMachineGuid(
          sh("reg", ["query", "HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"]),
        );
        if (!id) throw new Error("reg query answered without a MachineGuid");
        return deriveMachineKey(id);
      }
      if (process.platform === "darwin") {
        const id = parsePlatformUuid(sh("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]));
        if (!id) throw new Error("ioreg answered without an IOPlatformUUID");
        return deriveMachineKey(id);
      }
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const id = readFileSync(p, "utf8").trim();
          if (id) return deriveMachineKey(id);
        } catch {
          /* try the next location */
        }
      }
      throw new Error("no machine-id file on this system");
    },
  };
}

// --- resolution ---------------------------------------------------------------------------------

export interface KeyMaterial {
  id: string;
  key: Buffer;
}

/** The strongest source first; the machine-id fallback is always last so a sealed file from a
 *  machine whose credential-store entry vanished still opens. */
function platformSources(): KeySource[] {
  if (process.platform === "win32") return [dpapiSource(), machineIdSource()];
  if (process.platform === "darwin") return [keychainSource(), machineIdSource()];
  if (process.platform === "linux") return [secretToolSource(), machineIdSource()];
  return [machineIdSource()];
}

let cached: KeyMaterial[] | undefined;

/**
 * Every key a sealed file might open with, strongest first. Throws - with instructions - when
 * nothing can produce a key at all (an exotic box with no credential store and no machine id).
 */
export function masterKeyCandidates(): KeyMaterial[] {
  const envKey = process.env[MASTER_KEY_ENV];
  if (envKey !== undefined) {
    // An explicit key never mixes with OS sources: the operator said which key to use.
    return [{ id: "env", key: parseKeyHex(envKey, MASTER_KEY_ENV) }];
  }
  if (cached) return cached;
  const out: KeyMaterial[] = [];
  const failures: string[] = [];
  for (const src of platformSources()) {
    try {
      out.push({ id: src.id, key: src.get() });
    } catch (err) {
      failures.push(src.id + ": " + (err as Error).message);
    }
  }
  if (!out.length) {
    throw new Error(
      "no master key source worked (" + failures.join("; ") + "). " +
        "Set " + MASTER_KEY_ENV + " to 64 hex chars to bootstrap one manually.",
    );
  }
  cached = out;
  return out;
}

/** Forget the cached key, so the next call re-resolves it. Tests only. */
export function resetKeyCacheForTests(): void {
  cached = undefined;
}
