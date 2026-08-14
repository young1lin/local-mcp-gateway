import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir } from "../src/tunnels/api.js";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-browse-"));
  mkdirSync(join(root, "sub"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "id_rsa"), "x");
  writeFileSync(join(root, "deploy.pem"), "y");
  writeFileSync(join(root, "sub", "key.pem"), "z");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("listDir", () => {
  it("lists dirs and files, dirs first then alphabetical, with a parent to go up", () => {
    const listing = listDir(root);
    expect(listing.dir).toBe(root);
    expect(listing.parent).toBeDefined();
    const names = listing.entries.map((e) => e.name);
    expect(names).toEqual([".hidden", "sub", "deploy.pem", "id_rsa"]); // dirs first, then files, alpha
    expect(listing.entries.find((e) => e.name === "sub")?.dir).toBe(true);
    expect(listing.entries.find((e) => e.name === "id_rsa")?.dir).toBe(false);
    expect(listing.entries.find((e) => e.name === "id_rsa")?.path).toBe(join(root, "id_rsa"));
  });

  it("navigates into a subdirectory, whose parent is the root", () => {
    const listing = listDir(join(root, "sub"));
    expect(listing.dir).toBe(join(root, "sub"));
    expect(listing.parent).toBe(root);
    expect(listing.entries.map((e) => e.name)).toEqual(["key.pem"]);
  });

  it("returns an error instead of throwing for a missing directory", () => {
    const listing = listDir(join(root, "does-not-exist"));
    expect(listing.entries).toEqual([]);
    expect(listing.error).toBeTruthy();
  });
});
