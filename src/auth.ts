/**
 * Credential helpers for the HTTP surface.
 *
 * The MCP endpoints (`POST /<name>`) stay bearer-token-gated: that token is what AI clients
 * authenticate with and is managed per client from the panel. The management API under /api has no
 * credential check — the router's loopback guard is its boundary (see makeAuthed in adminapi.ts).
 */

/** Pull the `<token>` out of `Authorization: Bearer <token>`, or "" when the header is absent. */
export function bearerSecret(header: string | undefined): string {
  return header && header.startsWith("Bearer ") ? header.slice(7) : "";
}
