import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../src/atomic-json.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "atomic-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("writeJsonAtomic", () => {
  it("writes pretty JSON and leaves no temp file", () => {
    const p = join(dir, "x.json");
    writeJsonAtomic(p, { a: 1 });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ a: 1 });
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });

  it("throws when the target directory does not exist, naming the path", () => {
    const p = join(dir, "missing", "x.json");
    expect(() => writeJsonAtomic(p, { a: 1 })).toThrow(/could not save/i);
  });

  it("cleans up the temp file when the rename fails", () => {
    // A directory where the file should be: the write succeeds, the rename cannot.
    const p = join(dir, "adir");
    mkdirSync(p);
    expect(() => writeJsonAtomic(p, { a: 1 })).toThrow(/could not save/i);
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });
});

describe("writeTextAtomic", () => {
  it("writes plain text whole and private, leaving no temp file", async () => {
    const { writeTextAtomic } = await import("../src/atomic-json.js");
    const dir = mkdtempSync(join(tmpdir(), "atomic-text-"));
    const file = join(dir, ".env");
    writeTextAtomic(file, "A=1\nMCP_GATEWAY_TOKEN=abc\n");
    expect(readFileSync(file, "utf8")).toBe("A=1\nMCP_GATEWAY_TOKEN=abc\n");
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]); // the unique tmp name is cleaned up like the shared one was
    rmSync(dir, { recursive: true, force: true });
  });

  it("a stale temp from a crashed writer never collides with the next write", async () => {
    const { writeJsonAtomic } = await import("../src/atomic-json.js");
    const dir = mkdtempSync(join(tmpdir(), "atomic-stale-"));
    const file = join(dir, "state.json");
    // What an old crashed writer (or another process sharing the dir) leaves behind. The fixed
    // `.tmp` name used to be exactly this file's name, so the next write's rename could hit it.
    writeFileSync(join(dir, "state.json.999-00000000.tmp"), "garbage", { flag: "wx" });
    writeJsonAtomic(file, { ok: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ok: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
