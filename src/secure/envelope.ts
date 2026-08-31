import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * The sealed-envelope format every gateway state file is written in.
 *
 * { "lmg": 1, alg, keySource, salt, iv, tag, ct } - AES-256-GCM over the UTF-8 JSON payload, with
 * a per-file random salt so the master key is stretched through HKDF per file (key reuse across
 * files is fine; two identical payloads still seal to different ciphertext). The GCM tag is the
 * authenticity check: a wrong key, a tampered byte, a truncated file - all fail the tag, which is
 * how "this file was not sealed on this machine" is detected.
 *
 * keySource names the backend that sealed the file (dpapi / keychain / secrettool / machineid /
 * env) - a diagnostic, never trusted: opening always tries every available candidate and lets the
 * tag decide.
 */

const FORMAT_VERSION = 1;
const HKDF_INFO = "lmg-state-v1";

export interface Sealed {
  lmg: number;
  alg: string;
  keySource: string;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

/** True when the parsed JSON is one of OUR envelopes (and therefore not user-authored config). */
export function isSealed(v: unknown): v is Sealed {
  return (
    !!v && typeof v === "object" && !Array.isArray(v) &&
    (v as Record<string, unknown>).lmg === FORMAT_VERSION &&
    typeof (v as Record<string, unknown>).alg === "string" &&
    typeof (v as Record<string, unknown>).ct === "string"
  );
}

function fileKey(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, salt, HKDF_INFO, 32));
}

/** Seal one UTF-8 payload under a master key. */
export function seal(master: Buffer, keySource: string, plaintext: string): Sealed {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKey(master, salt), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    lmg: FORMAT_VERSION,
    alg: "aes-256-gcm",
    keySource,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

/**
 * Open an envelope. Throws on ANY mismatch - wrong key, other machine, tampering, or a format
 * newer than this build - so callers treat every failure as "not openable here".
 */
export function unseal(master: Buffer, sealed: Sealed): string {
  if (sealed.lmg !== FORMAT_VERSION) {
    throw new Error("sealed with format v" + sealed.lmg + "; this build understands v" + FORMAT_VERSION);
  }
  if (sealed.alg !== "aes-256-gcm") throw new Error("unknown cipher: " + sealed.alg);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    fileKey(master, Buffer.from(sealed.salt, "base64")),
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
  return pt.toString("utf8");
}
