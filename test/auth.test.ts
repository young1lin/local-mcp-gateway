import { describe, it, expect } from "vitest";
import { verifyBearer } from "../src/auth.js";

describe("verifyBearer", () => {
  const expected = "s3cret-token";
  it("accepts a correct bearer header", () => {
    expect(verifyBearer(`Bearer ${expected}`, expected)).toBe(true);
  });
  it("rejects missing header", () => {
    expect(verifyBearer(undefined, expected)).toBe(false);
  });
  it("rejects wrong token (different length)", () => {
    expect(verifyBearer("Bearer nope", expected)).toBe(false);
  });
  it("rejects wrong token (same length)", () => {
    expect(verifyBearer("Bearer s3cret-tokem", expected)).toBe(false);
  });
  it("rejects non-Bearer scheme", () => {
    expect(verifyBearer(expected, expected)).toBe(false);
  });
});
