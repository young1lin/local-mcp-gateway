import { timingSafeEqual } from "node:crypto";

/** Constant-time string comparison (length check first, then timingSafeEqual). */
function safeEqual(a: string, b: string): boolean {
  const ga = Buffer.from(a);
  const gb = Buffer.from(b);
  if (ga.length !== gb.length) return false;
  return timingSafeEqual(ga, gb);
}

/** Validate an `Authorization: Bearer <token>` header against the expected token. */
export function verifyBearer(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7), expected);
}

/** Pull the `<token>` out of `Authorization: Bearer <token>`, or "" when the header is absent. */
export function bearerSecret(header: string | undefined): string {
  return header && header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Validate an `Authorization: Basic base64(user:pass)` header against the given credentials. */
export function verifyBasic(header: string | undefined, user: string, pass: string): boolean {
  if (!header || !header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}
