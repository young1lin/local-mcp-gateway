import type { IncomingMessage } from "node:http";

/**
 * This gateway serves one machine: the one it runs on.
 *
 * It holds live database credentials, SSH keys and third-party API keys, and hands whoever reaches it
 * a tool set that reads and writes production-adjacent data. There is no multi-user model, no per-user
 * authorization, and no intent to grow one — the token identifies a client, not a person. So "local"
 * is not a default here, it is the boundary, and it is enforced in three places because binding to
 * loopback alone does not achieve it:
 *
 * - the bind address, so the socket is never offered to another machine;
 * - the peer address, so the guarantee holds even if something else changed the bind;
 * - the `Host` header, which is the only thing that reveals a DNS-rebinding page — its domain resolves
 *   to 127.0.0.1, so the connection really is local, and every check above it passes.
 *
 * `Origin` is checked too: a page on another site cannot read our answers (no CORS headers are sent),
 * but a request with side effects still lands, and a refusal costs nothing.
 *
 * There is deliberately no opt-out. Reaching this gateway from another machine is what SSH port
 * forwarding is for.
 */

/** `localhost`, `::1`, or anything in 127.0.0.0/8 — matched whole, so `localhost.evil.test` does not. */
function isLoopbackName(name: string): boolean {
  const s = name.trim().toLowerCase();
  if (!s) return false;
  if (s === "localhost" || s === "::1" || s === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);
}

/**
 * Whether `host` from the config names only this machine.
 *
 * `0.0.0.0` and `::` are the ones worth naming: they read like "the local one" and mean "every
 * interface", which is exactly how a dev gateway ends up answering the office LAN.
 */
export function isLoopbackBindHost(host: unknown): boolean {
  return typeof host === "string" && isLoopbackName(host);
}

/** A connected peer's address. Node reports a loopback client as `::ffff:127.0.0.1` on a dual-stack
 *  socket, which is the same machine and has to be accepted. */
function isLoopbackPeer(addr: string | undefined): boolean {
  if (!addr) return false;
  const s = addr.trim().toLowerCase();
  return isLoopbackName(s.startsWith("::ffff:") ? s.slice(7) : s);
}

/** The host part of a `Host` header, without its port. Bracketed IPv6 keeps its brackets; an
 *  unbracketed IPv6 literal (malformed, but node may hand one over) is returned whole rather than
 *  chopped at its first colon. */
function hostnameOf(hostHeader: string): string {
  const s = hostHeader.trim();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return end < 0 ? s : s.slice(0, end + 1);
  }
  if (s.split(":").length > 2) return s; // unbracketed IPv6 — nothing to strip
  const i = s.indexOf(":");
  return i < 0 ? s : s.slice(0, i);
}

function isLoopbackOrigin(origin: string): boolean {
  if (origin === "null") return false; // an opaque origin (sandboxed iframe, file://) — not this machine
  try {
    return isLoopbackName(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Why this request is not local, or undefined when it is. The reason is returned rather than thrown so
 * the caller decides the status code, and so it can be logged verbatim.
 */
export function remoteRequestReason(req: IncomingMessage): string | undefined {
  const peer = req.socket?.remoteAddress;
  if (!isLoopbackPeer(peer)) {
    return `this gateway serves only its own machine (peer address ${peer ?? "unknown"})`;
  }
  const host = req.headers.host;
  if (!host || !isLoopbackName(hostnameOf(host))) {
    return `Host must name this machine, got ${host ? `"${host}"` : "no Host header"}`;
  }
  const origin = req.headers.origin;
  if (origin && !isLoopbackOrigin(origin)) {
    return `Origin "${origin}" is not this machine`;
  }
  return undefined;
}
