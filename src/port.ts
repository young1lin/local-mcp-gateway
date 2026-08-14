/** The port the gateway listens on when nothing else names one. */
export const DEFAULT_PORT = 19999;

/** A usable TCP listen port, or undefined if `v` is not one. Digit strings (env vars) are accepted. */
export function asListenPort(v: unknown): number | undefined {
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^\d+$/.test(s)) return undefined;
    v = Number(s);
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) return undefined;
  return v;
}

/** `MCP_GATEWAY_PORT` when it is set to a usable port. Empty/unset is undefined, not an error. */
export function envListenPort(): number | undefined {
  const raw = process.env.MCP_GATEWAY_PORT;
  if (raw === undefined || raw === "") return undefined;
  return asListenPort(raw);
}
