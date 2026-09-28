import { describe, it, expect } from "vitest";
import { TokenManager, type TokenPersistence } from "../src/token.js";
import type { TokenRec } from "../src/managed.js";

/** An in-memory store that remembers every save, so a test can assert what reached "disk". */
function memoryStore(initial: TokenRec[] = []): TokenPersistence & { saves: TokenRec[][] } {
  let tokens = initial.map((t) => ({ ...t }));
  const saves: TokenRec[][] = [];
  return {
    saves,
    getTokens: () => tokens.map((t) => ({ ...t })),
    saveTokens: (next) => {
      tokens = next.map((t) => ({ ...t }));
      saves.push(tokens);
    },
  };
}

describe("TokenManager with a token from the environment", () => {
  it("serves it as the default token without persisting it", () => {
    const store = memoryStore();
    const tokens = new TokenManager(store, "from-env", "from-env");
    expect(tokens.verify("from-env")?.id).toBe("default");
    expect(store.saves).toEqual([]); // the seed migration that normally saves it did not run
  });

  it("replaces a default token an earlier run saved, and keeps the other tokens", () => {
    const store = memoryStore([
      { id: "default", label: "default", secret: "old-random", createdAt: "" },
      { id: "c1", label: "codex", secret: "codex-secret", createdAt: "" },
    ]);
    const tokens = new TokenManager(store, "from-env", "from-env");
    expect(tokens.verify("from-env")?.id).toBe("default");
    expect(tokens.verify("old-random")).toBeUndefined();
    expect(tokens.verify("codex-secret")?.label).toBe("codex");
    // Dropped from disk at once, so unsetting the variable later cannot revive the old secret.
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0].map((t) => t.id)).toEqual(["c1"]);
  });

  it("does not write on boot when no default was stored", () => {
    const store = memoryStore([{ id: "c1", label: "codex", secret: "codex-secret", createdAt: "" }]);
    new TokenManager(store, "from-env", "from-env");
    expect(store.saves).toEqual([]);
  });

  it("marks only the environment's token in the list", () => {
    const store = memoryStore([{ id: "c1", label: "codex", secret: "codex-secret", createdAt: "" }]);
    const list = new TokenManager(store, "from-env", "from-env").list();
    expect(list.map((t) => [t.id, t.fromEnvironment])).toEqual([["default", true], ["c1", false]]);
    expect(new TokenManager(memoryStore(), "seed").list()[0].fromEnvironment).toBe(false);
  });

  it("leaves it out of every save and refuses to rotate or revoke it", () => {
    const store = memoryStore();
    const tokens = new TokenManager(store, "from-env", "from-env");
    tokens.create("claude-code");
    expect(store.saves.at(-1)!.map((t) => t.label)).toEqual(["claude-code"]);
    expect(JSON.stringify(store.saves)).not.toContain("from-env");

    expect(tokens.fromEnvironment("default")).toBe(true);
    expect(tokens.rotate("default")).toBeUndefined();
    expect(tokens.remove("default")).toBe(false);
    expect(tokens.verify("from-env")?.id).toBe("default");
  });

  it("without one, the seed still migrates to a saved default token as before", () => {
    const store = memoryStore();
    const tokens = new TokenManager(store, "seed");
    expect(tokens.fromEnvironment("default")).toBe(false);
    expect(store.saves.at(-1)!.map((t) => t.secret)).toEqual(["seed"]);
  });
});
