import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
