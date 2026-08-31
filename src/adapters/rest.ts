import { DirectAdapter } from "./direct.js";
import type { ToolDef } from "./tool-server.js";
import type { ServerDef } from "../config.js";
import { applyDefaults, compileInput, renderPath, renderTemplate, type InputDecl } from "./rest-template.js";
import { assertProxyUrl, proxiedFetch } from "./proxy-fetch.js";

/** How much of a failed response body is quoted back in the error. Enough to carry the API's own
 *  error code and message, short enough not to become the tool result. */
const ERROR_BODY_MAX = 600;
const DEFAULT_TIMEOUT_MS = 30000;

/** One tool, declared in config. `request` is the vendor's own example with `{{arg}}` in the slots. */
interface ToolDecl {
  name: string;
  description: string;
  input?: InputDecl;
  request: {
    method?: string;
    path?: string;
    /** Rendered into the query string; a parameter with nothing behind it is left out. */
    query?: Record<string, unknown>;
    /** Sent as JSON when present. Omit it for GET. */
    body?: unknown;
  };
  /** Top-level response keys worth keeping. Omit to return the whole response. */
  pick?: string[];
}

function parseTools(def: ServerDef): ToolDecl[] {
  const raw = def.tools;
  if (!Array.isArray(raw)) throw new Error("a rest MCP needs a `tools` array");
  return raw.map((t, i) => {
    const decl = t as ToolDecl;
    if (!decl?.name) throw new Error(`rest tool #${i} has no name`);
    if (!decl.request) throw new Error(`rest tool ${decl.name} has no request`);
    return decl;
  });
}

/**
 * Turns a plain HTTP API into MCP tools from config alone — the companion to `http`, which needs the
 * far end to already speak MCP.
 *
 * It exists because a plain HTTP API is the common case: most do not speak MCP at all, and even the
 * ones that do often expose more over REST than their MCP tool surfaces — parameters the vendor never
 * wired through. Declaring the REST endpoint here trades "somebody else maintains the schema" for
 * control over the request, without writing an adapter.
 *
 * Deliberately no `ping`: a declared REST API is as metered as a remote MCP, and the registry's 15s
 * health probe would spend real money to colour a dot. Absent `ping` makes the registry report
 * "unknown", which is the truth.
 */
export class RestAdapter extends DirectAdapter {
  readonly type = "rest";
  private readonly decls: ToolDecl[] = parseTools(this.def);
  private readonly byName = new Map(this.decls.map((d) => [d.name, d]));
  protected readonly tools: ToolDef[] = this.decls.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: compileInput(d.input),
  }));
  /** Validated at construction (a bad proxy is a start error), used per request in call(). */
  private readonly proxyUrl = this.def.proxy ? assertProxyUrl(String(this.def.proxy)) : undefined;

  protected get target(): string {
    return String(this.def.baseUrl ?? "");
  }

  /** Nothing to connect: every call is its own request. */
  protected open(): Promise<void> {
    return Promise.resolve();
  }

  private get headers(): Record<string, string> {
    const h = this.def.headers;
    return h && typeof h === "object" ? (h as Record<string, string>) : {};
  }

  private get timeoutMs(): number {
    const v = Number(this.def.timeoutMs);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
  }

  protected async call(tool: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const decl = this.byName.get(tool);
    if (!decl) throw new Error(`unknown tool: ${tool}`);
    // Defaults and required-argument checks first: a call that cannot be rendered must not become a
    // request, least of all a billed one.
    const filled = applyDefaults(decl.input, args);
    const method = (decl.request.method ?? "GET").toUpperCase();
    const url = new URL(this.target + renderPath(decl.request.path ?? "", filled));
    for (const [k, v] of Object.entries((renderTemplate(decl.request.query ?? {}, filled) ?? {}) as Record<string, unknown>)) {
      url.searchParams.set(k, String(v));
    }
    const body = decl.request.body === undefined ? undefined : renderTemplate(decl.request.body, filled);
    const headers: Record<string, string> = { accept: "application/json", ...this.headers };
    if (body !== undefined) headers["content-type"] = "application/json";

    // Proxied per-MCP when the def names one; global fetch otherwise (see proxy-fetch.ts).
    const doFetch = this.proxyUrl ? proxiedFetch(this.proxyUrl) : fetch;
    const res = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      // The vendor's own error code is the useful part (a 429 with a rate-limit body means "slow
      // down"), so it is quoted rather than replaced with a generic message.
      const excerpt = text.length > ERROR_BODY_MAX ? `${text.slice(0, ERROR_BODY_MAX)}…` : text;
      throw new Error(`${method} ${url.pathname} failed: HTTP ${res.status}\n${excerpt}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text; // not JSON — hand it over as it came, bounded by the output budget
    }
    if (!decl.pick?.length || !parsed || typeof parsed !== "object") return parsed;
    const picked: Record<string, unknown> = {};
    for (const key of decl.pick) {
      const v = (parsed as Record<string, unknown>)[key];
      if (v !== undefined) picked[key] = v;
    }
    return picked;
  }
}
