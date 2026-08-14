/**
 * The declaration language behind `type: "rest"`: turn a plain HTTP API into MCP tools from config
 * alone, with no adapter written for it.
 *
 * The design rule is that **the request you write is the request that gets sent**. A tool's `request`
 * block is the vendor's own example, copied out of their docs, with the values you want the model to
 * control swapped for `{{arg}}`. Everything else stays a literal, which is why there is no separate
 * notion of "fixed values" or "parameter mapping" — a pinned `"Accept": "application/json"` is just
 * that string, sitting where the API expects it.
 *
 * `{{arg}}` and NOT `${arg}`: `${VAR}` already means "environment variable" everywhere in this config
 * (see resolveStr in src/config.ts), and it is expanded before an adapter ever sees the definition.
 * Two syntaxes that look identical and resolve from different places is a trap, so tool arguments get
 * a visibly different one.
 */

/** One declared tool argument. `type` is a JSON Schema scalar type — the model reads it in tools/list. */
export interface ArgDecl {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  required?: boolean;
  /** Used when the caller omits the argument. An argument with a default is never `required`. */
  default?: unknown;
  enum?: unknown[];
}
export type InputDecl = Record<string, ArgDecl>;

/** `{{name}}` occupying the whole string — the case that substitutes a typed value rather than text. */
const WHOLE_REF = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
/** Every `{{name}}` in a string, for the interpolating case. */
const ANY_REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Compile the compact `input` declaration into the JSON Schema a client sees in tools/list. */
export function compileInput(input: InputDecl | undefined): object {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [name, decl] of Object.entries(input ?? {})) {
    const prop: Record<string, unknown> = { type: decl.type };
    // A default is stated in prose rather than as JSON Schema's `default`, which clients render
    // inconsistently and models routinely ignore.
    const description = decl.default !== undefined
      ? [decl.description, `Defaults to ${JSON.stringify(decl.default)}.`].filter(Boolean).join(" ")
      : decl.description;
    if (description) prop.description = description;
    if (decl.enum) prop.enum = decl.enum;
    properties[name] = prop;
    if (decl.required) required.push(name);
  }
  return required.length ? { type: "object", properties, required } : { type: "object", properties };
}

/**
 * Fill in declared defaults and refuse a call missing a required argument.
 *
 * The check lives here rather than in the schema alone: a schema is advice to the model, and a missing
 * required value would otherwise reach the API as a dropped key and come back as somebody else's
 * confusing 400.
 */
export function applyDefaults(input: InputDecl | undefined, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(args ?? {}) };
  const missing: string[] = [];
  for (const [name, decl] of Object.entries(input ?? {})) {
    if (out[name] === undefined && decl.default !== undefined) out[name] = decl.default;
    if (out[name] === undefined && decl.required) missing.push(name);
  }
  if (missing.length) throw new Error(`missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  return out;
}

/**
 * Render a request template against the call's arguments.
 *
 * Returns `undefined` for a value that has nothing behind it — the caller drops that key (or that
 * array element) rather than sending a null. Sending `null` for an omitted optional is how you get a
 * validation error out of an API that would have been perfectly happy with the field absent.
 */
export function renderTemplate(node: unknown, args: Record<string, unknown>): unknown {
  if (typeof node === "string") {
    const whole = WHOLE_REF.exec(node);
    if (whole) return args[whole[1]]; // undefined when absent — the drop signal
    let missing = false;
    const text = node.replace(ANY_REF, (_m, name: string) => {
      const v = args[name];
      if (v === undefined) { missing = true; return ""; }
      return String(v);
    });
    return missing ? undefined : text;
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      const rendered = renderTemplate(item, args);
      if (rendered !== undefined) out.push(rendered);
    }
    return out;
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const rendered = renderTemplate(v, args);
      if (rendered !== undefined) out[k] = rendered;
    }
    return out;
  }
  return node; // number, boolean, null — a literal
}

/**
 * Interpolate a request path. Unlike a body key, a path segment cannot be dropped — `/repos//x` is a
 * different endpoint — so an unfilled reference is an error. Values are percent-encoded, so a `/` in
 * an argument stays inside its own segment instead of inventing a new one.
 */
export function renderPath(path: string, args: Record<string, unknown>): string {
  const missing: string[] = [];
  const out = path.replace(ANY_REF, (_m, name: string) => {
    const v = args[name];
    if (v === undefined) { missing.push(name); return ""; }
    return encodeURIComponent(String(v));
  });
  if (missing.length) throw new Error(`path ${path} needs ${missing.join(", ")}`);
  return out;
}
