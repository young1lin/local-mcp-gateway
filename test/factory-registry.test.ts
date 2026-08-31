import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalAdapter, makeAdapter, registerAdapterFactory } from "../src/adapters/factory.js";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const FIXTURE = join(FIXTURE_DIR, "external-adapter.mjs");
const BROKEN = join(FIXTURE_DIR, "external-broken.mjs");

describe("adapter registry", () => {
  it("registers a new type, and hands it the resolved def", () => {
    process.env.LMG_TEST_SECRET = "s3cret";
    const seen: unknown[] = [];
    registerAdapterFactory("registry-fixture", (def, name) => {
      seen.push({ password: def.password, name });
      // build() never runs here — the factory itself is what this test exercises.
      return { type: "registry-fixture", async build() { throw new Error("not built here"); } };
    });

    const a = makeAdapter({ type: "registry-fixture", password: "${LMG_TEST_SECRET}" }, "mine");
    expect(a.type).toBe("registry-fixture");
    // The ${ENV} reference is expanded before the factory sees the def — same deal as built-ins.
    expect(seen).toEqual([{ password: "s3cret", name: "mine" }]);
    delete process.env.LMG_TEST_SECRET;
  });

  it("refuses a duplicate registration instead of shadowing a type", () => {
    expect(() => registerAdapterFactory("echo", () => { throw new Error("never called"); }))
      .toThrow(/already registered/);
  });

  it("still refuses an unknown type that names no adapter module", () => {
    expect(() => makeAdapter({ type: "nope" })).toThrow(/Unknown adapter type.*"adapter"/s);
  });
});

describe("external adapters", () => {
  const home = mkdtempSync(join(tmpdir(), "lmg-ext-"));

  beforeEach(() => {
    process.env.MCP_GATEWAY_HOME = home; // where a "./relative" adapter spec resolves
  });
  afterEach(() => {
    delete process.env.MCP_GATEWAY_HOME;
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("loads a module by absolute path, builds, and delegates close/ping/makeServer", async () => {
    const marker = join(home, "closed.txt");
    const made = makeAdapter({ type: "fixture-ext", adapter: FIXTURE, closedMarker: marker, pingError: "boom" });
    expect(made).toBeInstanceOf(ExternalAdapter);
    // ExternalAdapter pins ping/makeServer/close as real methods, so they can be called directly.
    const a = made as ExternalAdapter;
    expect(a.type).toBe("fixture-ext");

    // Import is deferred to build(): makeAdapter itself must not touch the module.
    const server = await a.build();
    expect(typeof server.setRequestHandler).toBe("function");
    expect(a.makeServer()).not.toBe(server); // delegated — the fixture builds a fresh one

    expect(typeof a.ping).toBe("function"); // present only because the inner adapter has one
    await expect(a.ping!()).rejects.toThrow(/boom/); // delegated to the inner ping
    await a.close();
    expect(existsSync(marker)).toBe(true); // delegated to the inner close
  });

  it("resolves a ./relative spec against the data dir", async () => {
    // The data dir is pointed at the fixtures dir, so "./external-adapter.mjs" must land on the
    // same module the absolute-path test used — proving the ./ resolution without depending on
    // where the process cwd happens to be.
    process.env.MCP_GATEWAY_HOME = FIXTURE_DIR;
    const a = makeAdapter({ type: "mine", adapter: "./external-adapter.mjs" });
    await expect(a.build()).resolves.toBeTruthy();
  });

  it("close before build is a no-op, not a crash", async () => {
    const a = makeAdapter({ type: "mine", adapter: FIXTURE }) as ExternalAdapter;
    await expect(a.close()).resolves.toBeUndefined();
  });

  it("fails loud on a module that exports no createAdapter", async () => {
    const a = makeAdapter({ type: "mine", adapter: BROKEN });
    await expect(a.build()).rejects.toThrow(/createAdapter/);
  });

  it("an unknown type with an adapter field is external, not an error at make time", () => {
    // The unknown-type error is for defs with no adapter field; naming one defers everything to build.
    const a = makeAdapter({ type: "brand-new", adapter: "some-package" });
    expect(a).toBeInstanceOf(ExternalAdapter);
  });
});
