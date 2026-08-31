import { describe, it, expect } from "vitest";
import { pickCopyToken } from "../src/token.js";

const defaultTok = { id: "default", label: "default" };
const claude = { id: "aa11", label: "claude-code" };
const cursor = { id: "bb22", label: "cursor" };

describe("pickCopyToken", () => {
  it("prefers the remembered id when that token still exists", () => {
    expect(pickCopyToken([defaultTok, claude], "aa11")).toEqual(claude);
  });

  it("falls back to the default-labeled token when nothing is remembered", () => {
    expect(pickCopyToken([claude, defaultTok, cursor], null)).toEqual(defaultTok);
    expect(pickCopyToken([claude, defaultTok, cursor], "")).toEqual(defaultTok);
  });

  it("falls back to default when the remembered id was revoked", () => {
    expect(pickCopyToken([defaultTok, claude], "gone")).toEqual(defaultTok);
  });

  it("uses the only remaining token if default is gone too", () => {
    expect(pickCopyToken([claude], "gone")).toEqual(claude);
  });

  it("returns undefined for an empty list", () => {
    expect(pickCopyToken([], "default")).toBeUndefined();
  });
});
