import { randomBytes, timingSafeEqual } from "node:crypto";
import type { TokenRec } from "./managed.js";

/** The slice of a ManagedStore a TokenManager needs — so tests can pass an in-memory stand-in. */
export interface TokenPersistence {
  getTokens(): TokenRec[];
  saveTokens(tokens: TokenRec[]): void;
}

/** A token as the panel/API ever sees it — no secret. */
export interface PublicToken {
  id: string;
  label: string;
  createdAt: string;
}

/**
 * Which named token copied connect commands should embed.
 *
 * A remembered id (from the panel's "Use" button) wins while it still exists. Otherwise the
 * seed token labeled `default` — so copy works on a fresh panel with several tokens, without a
 * prompt the Cursor IDE browser cannot answer. If `default` is gone too, the first remaining row.
 */
export function pickCopyToken<T extends { id: string; label: string }>(
  list: readonly T[],
  rememberedId: string | null | undefined,
): T | undefined {
  if (!list.length) return undefined;
  if (rememberedId) {
    const remembered = list.find((t) => t.id === rememberedId);
    if (remembered) return remembered;
  }
  return list.find((t) => t.label === "default") ?? list[0];
}

function safeEq(a: string, b: string): boolean {
  const ga = Buffer.from(a);
  const gb = Buffer.from(b);
  if (ga.length !== gb.length) return false;
  return timingSafeEqual(ga, gb);
}
function newId(): string {
  return randomBytes(6).toString("hex");
}
/** A fresh 24-byte hex secret — the same recipe the README shows for a hand-made token. */
export function newSecret(): string {
  return randomBytes(24).toString("hex");
}

/**
 * The live set of named bearer tokens. Each client (Claude Code, Codex, …) gets its own, so the
 * interaction log can attribute every request to a client and one client can be revoked without
 * rotating the rest. `verify` returns the matched record (not just true/false) so the caller knows
 * WHO authenticated. Built once at boot; every mutation persists through the ManagedStore.
 *
 * On first boot the pre-multi-token secret migrates to a "default" token, so clients already
 * configured with the old secret keep authenticating unchanged.
 */
export class TokenManager {
  private items: TokenRec[];

  constructor(private store: TokenPersistence, seed?: string) {
    const stored = store.getTokens();
    if (stored.length) {
      this.items = stored;
    } else if (seed) {
      this.items = [{ id: "default", label: "default", secret: seed, createdAt: "" }];
      store.saveTokens(this.items); // persist the migration so the seed is stable across restarts
    } else {
      this.items = [];
    }
  }

  /** Resolve a bearer secret to its token record, or undefined. */
  verify(secret: string): TokenRec | undefined {
    return this.items.find((t) => safeEq(t.secret, secret));
  }

  /** All tokens, secrets stripped — for the panel and the list API. */
  list(): PublicToken[] {
    return this.items.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }

  get(id: string): TokenRec | undefined {
    return this.items.find((t) => t.id === id);
  }

  /** Create a token. The secret is returned here and stays readable via get() — see the note on
   *  GET /api/tokens/:id/secret for why it is not write-only. */
  create(label: string): TokenRec {
    const rec: TokenRec = {
      id: newId(),
      label: label.trim() || "token",
      secret: newSecret(),
      createdAt: new Date().toISOString(),
    };
    this.items.push(rec);
    this.store.saveTokens(this.items);
    return rec;
  }

  /** Rotate one token's secret (keeps id + label; the old secret stops working immediately). */
  rotate(id: string): TokenRec | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    rec.secret = newSecret();
    this.store.saveTokens(this.items);
    return rec;
  }

  /** Revoke a token. Returns false when no token had that id. */
  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((t) => t.id !== id);
    const changed = this.items.length < before;
    if (changed) this.store.saveTokens(this.items);
    return changed;
  }
}

/** A TokenManager over a throwaway in-memory store, seeded with one token — for tests. */
export function singleTokenManager(secret: string): TokenManager {
  let store: TokenRec[] = [];
  return new TokenManager(
    { getTokens: () => store, saveTokens: (t) => { store = t.slice(); } },
    secret,
  );
}
