import { describe, it, expect } from "vitest";
import { Registry } from "../src/registry.js";
import { echoAdapter } from "../src/adapters/echo.js";
import type { Adapter } from "../src/adapters/types.js";
import type { Server } from "@modelcontextprotocol/server";

/** Adapter that builds a fresh echo server and optionally has a ping(). */
function fakeAdapter(ping?: () => Promise<void>): Adapter {
  return {
    type: "fake",
    async build(): Promise<Server> {
      return echoAdapter.build();
    },
    ping,
  };
}

function reg() {
  return new Registry(60000);
}

describe("Registry lifecycle", () => {
  it("starts and exposes a server, then stops and clears it", async () => {
    const r = reg();
    r.register("a", "managed", { type: "fake" }, fakeAdapter());
    expect(r.getServer("a")).toBeUndefined();
    await r.start("a");
    expect(r.getServer("a")).toBeDefined();
    await r.stop("a");
    expect(r.getServer("a")).toBeUndefined();
  });

  it("start is idempotent (already started does not throw or rebuild)", async () => {
    const r = reg();
    r.register("a", "managed", { type: "fake" }, fakeAdapter());
    await r.start("a");
    const first = r.getServer("a");
    await r.start("a"); // no-op
    expect(r.getServer("a")).toBe(first);
  });

  it("stop is idempotent", async () => {
    const r = reg();
    r.register("a", "managed", { type: "fake" }, fakeAdapter());
    await r.start("a");
    await r.stop("a");
    await expect(r.stop("a")).resolves.toBeUndefined();
  });

  it("restart rebuilds the server", async () => {
    const r = reg();
    r.register("a", "managed", { type: "fake" }, fakeAdapter());
    await r.start("a");
    const before = r.getServer("a");
    await r.restart("a");
    expect(r.getServer("a")).not.toBe(before);
  });

  it("rename moves the entry under a new key", async () => {
    const r = reg();
    r.register("old", "managed", { type: "fake" }, fakeAdapter());
    await r.start("old");
    await r.rename("old", "new");
    expect(r.has("old")).toBe(false);
    expect(r.has("new")).toBe(true);
    expect(r.getServer("new")).toBeDefined();
  });

  it("rejects rename onto an existing name", async () => {
    const r = reg();
    r.register("a", "managed", { type: "fake" }, fakeAdapter());
    r.register("b", "managed", { type: "fake" }, fakeAdapter());
    await expect(r.rename("a", "b")).rejects.toThrow(/already exists/);
  });

  it("deletes a managed MCP", async () => {
    const r = reg();
    r.register("a", "managed", { type: "fake" }, fakeAdapter());
    await r.start("a");
    await r.delete("a");
    expect(r.has("a")).toBe(false);
  });

  // The old refusal existed because deleting a config MCP left its gateway.config.json entry
  // behind, so it resurrected on restart. The admin API now removes the file entry too — the
  // registry half deletes any source, stopping first.
  it("deletes a config MCP as well (stop first, then drop the entry)", async () => {
    const r = reg();
    r.register("a", "config", { type: "fake" }, fakeAdapter());
    await r.start("a");
    await r.delete("a");
    expect(r.has("a")).toBe(false);
  });
});

describe("Registry health", () => {
  it("marks a passing ping as up with latency", async () => {
    const r = reg();
    r.register("ok", "config", { type: "fake" }, fakeAdapter(async () => { await new Promise((x) => setTimeout(x, 5)); }));
    await r.start("ok");
    await r.checkAll();
    const row = r.status().find((s) => s.name === "ok")!;
    expect(row.state).toBe("up");
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(row.reason).toBeUndefined();
  });

  it("captures the raw failure reason when ping throws", async () => {
    const r = reg();
    r.register("bad", "config", { type: "fake" }, fakeAdapter(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:6379"); }));
    await r.start("bad");
    await r.checkAll();
    const row = r.status().find((s) => s.name === "bad")!;
    expect(row.state).toBe("down");
    expect(row.reason).toContain("ECONNREFUSED");
  });

  it("reports unknown when an adapter has no ping()", async () => {
    const r = reg();
    r.register("none", "config", { type: "fake" }, fakeAdapter());
    await r.start("none");
    await r.checkAll();
    expect(r.status().find((s) => s.name === "none")!.state).toBe("unknown");
  });

  it("does not probe a stopped entry and reports state 'stopped'", async () => {
    const r = reg();
    r.register("off", "config", { type: "fake" }, fakeAdapter(async () => { throw new Error("should not be called"); }));
    // not started
    await r.checkAll();
    expect(r.status().find((s) => s.name === "off")!.state).toBe("stopped");
  });
});

describe("Registry concurrent lifecycle operations", () => {
  /** Adapter whose build() is slow and counted, so a double-build is observable. */
  function countingAdapter(delayMs = 30) {
    const state = { builds: 0, closes: 0 };
    const adapter: Adapter = {
      type: "counting",
      async build(): Promise<Server> {
        state.builds++;
        await new Promise((r) => setTimeout(r, delayMs));
        return echoAdapter.build();
      },
      async close(): Promise<void> {
        state.closes++;
      },
    };
    return { adapter, state };
  }

  it("builds once when two starts arrive together", async () => {
    const r = reg();
    const { adapter, state } = countingAdapter();
    r.register("a", "managed", { type: "counting" }, adapter);
    await Promise.all([r.start("a"), r.start("a")]);
    // A second build would be orphaned: never assigned to the entry, never closed. For a proc
    // adapter that is a stray child process — the exact failure the direct adapters removed.
    expect(state.builds).toBe(1);
    expect(r.getServer("a")).toBeDefined();
  });

  it("does not leave a server behind when stop races start", async () => {
    const r = reg();
    const { adapter, state } = countingAdapter();
    r.register("a", "managed", { type: "counting" }, adapter);
    await Promise.all([r.start("a"), r.stop("a")]);
    // Whichever order they run in, the two must not interleave: a start that completes after a
    // stop must leave the entry either cleanly started or cleanly stopped, never built-but-lost.
    if (r.getServer("a")) expect(state.builds - state.closes).toBe(1);
    else expect(state.builds).toBe(state.closes);
  });

  it("serializes restart against a concurrent start", async () => {
    const r = reg();
    const { adapter, state } = countingAdapter();
    r.register("a", "managed", { type: "counting" }, adapter);
    await r.start("a");
    await Promise.all([r.restart("a"), r.start("a")]);
    expect(r.getServer("a")).toBeDefined();
    // Every build that happened was either closed or is the live one.
    expect(state.builds - state.closes).toBe(1);
  });
});

describe("Registry health probing", () => {
  it("discards a probe result that lands after the MCP was stopped", async () => {
    const r = reg();
    const adapter: Adapter = {
      type: "slow",
      async build(): Promise<Server> { return echoAdapter.build(); },
      async close(): Promise<void> {},
      ping: () => new Promise((_res, rej) => setTimeout(() => rej(new Error("connect ECONNREFUSED 127.0.0.1:6379")), 60)),
    };
    r.register("a", "managed", { type: "slow" }, adapter);
    await r.start("a");

    const probing = r.checkAll();            // ping now in flight
    await new Promise((res) => setTimeout(res, 10));
    await r.stop("a");                        // user stops it before the ping settles
    await probing;                            // the stale rejection arrives here

    // Stopping cleared the reason; a probe belonging to the previous run must not write it back,
    // and nothing resets lastError for a stopped entry, so it would have stuck until a restart.
    expect(r.get("a")!.lastError).toBeUndefined();
    expect(r.get("a")!.status).toBe("unknown");
  });
});

describe("Registry delete vs a queued start", () => {
  it("refuses a start that slips into the delete window instead of building on the detached entry", async () => {
    let builds = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slowClose: Adapter = {
      type: "fake",
      async build() { builds++; return echoAdapter.build(); },
      async close() { await held; },
    };
    const r = new Registry(60000);
    r.register("x", "managed", { type: "fake" }, slowClose);
    await r.start("x");
    expect(builds).toBe(1);

    // delete() parks inside adapter.close(); a start arriving in that window enqueues behind the
    // stop and runs AFTER entries.delete — on the detached entry, where doStart must refuse.
    const del = r.delete("x");
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the delete reach close()
    // Attach the handlers IMMEDIATELY: the refusal rejects while `await del` is still pending, and
    // a promise rejected in that window with no handler yet attached is an unhandledRejection.
    const lateStart = r.start("x").then(
      () => { throw new Error("expected the late start to refuse"); },
      (err: Error) => err,
    );
    release();
    await del;
    expect((await lateStart).message).toMatch(/unknown MCP: x/);
    expect(builds).toBe(1); // nothing was built that no entry would ever close
  });
});
