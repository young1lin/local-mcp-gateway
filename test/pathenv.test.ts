import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { extraBinDirs, loginPath } from "../src/pathenv.js";

describe("loginPath", () => {
  it("prepends extra dirs that are not already on PATH", () => {
    const path = ["C:\\Windows", "C:\\Windows\\System32"].join(delimiter);
    expect(loginPath(path, ["C:\\uv", "C:\\Windows"])).toBe(
      ["C:\\uv", "C:\\Windows", "C:\\Windows\\System32"].join(delimiter),
    );
  });

  it("is a no-op when every extra dir is already present", () => {
    const path = ["C:\\uv", "C:\\Windows"].join(delimiter);
    expect(loginPath(path, ["C:\\uv"])).toBe(path);
  });

  it("keeps PATH unchanged when there are no extras", () => {
    expect(loginPath("C:\\a", [])).toBe("C:\\a");
  });
});

describe("extraBinDirs", () => {
  it("only lists directories that exist on this machine", () => {
    for (const d of extraBinDirs()) expect(existsSync(d)).toBe(true);
  });
});
