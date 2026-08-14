import { describe, it, expect } from "vitest";
import { compileInput, applyDefaults, renderTemplate, renderPath, type InputDecl } from "../src/adapters/rest-template.js";

describe("compileInput", () => {
  it("compiles a compact declaration into an object JSON Schema", () => {
    const schema = compileInput({
      query: { type: "string", required: true, description: "What to search for" },
      count: { type: "number", default: 10 },
      recency: { type: "string", enum: ["oneDay", "noLimit"] },
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        count: { type: "number", description: "Defaults to 10." },
        recency: { type: "string", enum: ["oneDay", "noLimit"] },
      },
      required: ["query"],
    });
  });

  it("omits `required` entirely when nothing is required", () => {
    expect(compileInput({ q: { type: "string" } })).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });

  it("compiles an absent declaration into a no-argument schema", () => {
    expect(compileInput(undefined)).toEqual({ type: "object", properties: {} });
  });
});

describe("applyDefaults", () => {
  it("fills in a declared default the caller omitted", () => {
    const out = applyDefaults({ count: { type: "number", default: 10 } }, {});
    expect(out.count).toBe(10);
  });

  it("never overrides a value the caller passed, including a falsy one", () => {
    const decl: InputDecl = { count: { type: "number", default: 10 }, deep: { type: "boolean", default: true } };
    expect(applyDefaults(decl, { count: 0, deep: false })).toEqual({ count: 0, deep: false });
  });

  it("throws when a required argument is missing", () => {
    expect(() => applyDefaults({ query: { type: "string", required: true } }, {})).toThrow(/query/);
  });
});

/**
 * The heart of the declaration: the request body you write is the body that gets sent, so it can be
 * copied out of a vendor's docs and have its values swapped for `{{arg}}`.
 */
describe("renderTemplate", () => {
  it("substitutes a whole-string reference with the argument's own type", () => {
    const out = renderTemplate({ count: "{{count}}", flag: "{{flag}}" }, { count: 20, flag: false });
    expect(out).toEqual({ count: 20, flag: false }); // 20, not "20"
  });

  it("interpolates a reference embedded in surrounding text", () => {
    expect(renderTemplate({ q: "site:{{domain}} {{term}}" }, { domain: "a.test", term: "x" }))
      .toEqual({ q: "site:a.test x" });
  });

  it("keeps literals exactly as written", () => {
    const literals = { engine: "default", intent: false, n: 3, nothing: null };
    expect(renderTemplate(literals, {})).toEqual(literals);
  });

  it("drops a key whose reference has no argument behind it", () => {
    const out = renderTemplate({ q: "{{term}}", recency: "{{recency}}" }, { term: "x" });
    expect(out).toEqual({ q: "x" });
    expect(Object.keys(out as object)).not.toContain("recency");
  });

  it("drops a key when any reference inside a longer string is missing", () => {
    expect(renderTemplate({ q: "{{a}} and {{b}}" }, { a: "x" })).toEqual({});
  });

  it("renders nested objects and arrays, dropping what has nothing behind it", () => {
    const out = renderTemplate(
      { filter: { domain: "{{domain}}", size: "high" }, tags: ["fixed", "{{tag}}", "{{missing}}"] },
      { domain: "a.test", tag: "t" },
    );
    expect(out).toEqual({ filter: { domain: "a.test", size: "high" }, tags: ["fixed", "t"] });
  });

  it("returns undefined for a template that is nothing but a missing reference", () => {
    expect(renderTemplate("{{gone}}", {})).toBeUndefined();
  });
});

describe("renderPath", () => {
  it("interpolates path segments and percent-encodes them", () => {
    expect(renderPath("/repos/{{owner}}/{{repo}}", { owner: "a b", repo: "c/d" }))
      .toBe("/repos/a%20b/c%2Fd");
  });

  it("throws rather than send a path with an unfilled segment", () => {
    expect(() => renderPath("/repos/{{owner}}", {})).toThrow(/owner/);
  });

  it("leaves a path with no references alone", () => {
    expect(renderPath("/web_search", { a: 1 })).toBe("/web_search");
  });
});
