import { describe, it, expect } from "vitest";
import { bearerSecret } from "../src/auth.js";

describe("bearerSecret", () => {
  it("pulls the token out of a Bearer header", () => {
    expect(bearerSecret("Bearer s3cret-token")).toBe("s3cret-token");
  });
  it("returns an empty string when the header is absent", () => {
    expect(bearerSecret(undefined)).toBe("");
  });
  it("returns an empty string for a non-Bearer scheme", () => {
    expect(bearerSecret("Basic s3cret-token")).toBe("");
  });
  it("accepts a lowercase scheme and any run of spaces (RFC 7235)", () => {
    expect(bearerSecret("bearer s3cret-token")).toBe("s3cret-token");
    expect(bearerSecret("BEARER s3cret-token")).toBe("s3cret-token");
    expect(bearerSecret("Bearer   s3cret-token")).toBe("s3cret-token");
    expect(bearerSecret("Bearer s3cret-token extra")).toBe("s3cret-token extra");
  });
});
