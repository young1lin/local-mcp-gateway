/**
 * Credential helpers for the HTTP surface.
 *
 * The MCP endpoints (`POST /<name>`) stay bearer-token-gated: that token is what AI clients
 * authenticate with and is managed per client from the panel. The management API under /api has no
 * credential check — the router's loopback guard is its boundary (see makeAuthed in adminapi.ts).
 */

/**
 * The auth scheme prefix. Matched case-insensitively, and across any run of spaces, because RFC
 * 7235 says the scheme token is case-insensitive and separated by one or more SP — a client
 * sending `bearer <token>` is conformant, and rejecting it looked from the outside like a wrong
 * token.
 */
const BEARER_RE = /^bearer +/i;

/** Pull the `<token>` out of `Authorization: Bearer <token>`, or "" when the header is absent. */
export function bearerSecret(header: string | undefined): string {
  if (!header) return "";
  const m = BEARER_RE.exec(header);
  return m ? header.slice(m[0].length).trim() : "";
}
