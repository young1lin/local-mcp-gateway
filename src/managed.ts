import type { ServerDef } from "./config.js";
import { log } from "./log.js";
import { dataPath } from "./datadir.js";
import { readSecureJson, writeSecureJson } from "./secure/statefile.js";

/** A user-added MCP: its definition + whether it should auto-start. Persisted to managed.json. */
export interface ManagedEntry {
  name: string;
  def: ServerDef;
  enabled: boolean;
  /** True when this overrides a config-file MCP's def (so editing config MCPs persists here, not in gateway.config.json). */
  override?: boolean;
}

/** Read managed.json (returns [] when missing or invalid). */
export function loadManaged(path = dataPath("managed.json")): ManagedEntry[] {
  let raw: unknown;
  try {
    raw = readSecureJson(path);
  } catch (err) {
    log("warn", "managed load failed", { err: (err as Error).message, path });
    return [];
  }
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : (raw as { mcps?: unknown[] })?.mcps ?? [];
  return arr
    .map((e: any): ManagedEntry | null => {
      if (!e || typeof e.name !== "string") return null;
      if (!e.def || typeof e.def.type !== "string") return null;
      return { name: e.name, def: e.def as ServerDef, enabled: e.enabled !== false, override: e.override === true };
    })
    .filter((e): e is ManagedEntry => e !== null);
}

/**
 * Per-MCP tool toggles, keyed by MCP name: the list of tool names a user has turned off.
 *
 * Lives in managed.json alongside `mcps` so it applies to config-file MCPs too — the six DB MCPs are
 * config-sourced, so their toggles cannot be written back into gateway.config.json. Read from the
 * same file on load; absent in older files, which simply means "everything on".
 */
export function loadToolToggles(path = dataPath("managed.json")): Record<string, string[]> {
  try {
    const raw = readSecureJson<{ disabledTools?: Record<string, unknown> }>(path);
    if (!raw) return {};
    const dt = raw.disabledTools ?? {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(dt)) {
      if (Array.isArray(v)) out[k] = v.filter((s): s is string => typeof s === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/** Per-MCP resources on/off, keyed by MCP name. A stored value is the explicit toggle; absent means
 *  "never toggled" (use the default, which is on). */
export function loadResourceToggles(path = dataPath("managed.json")): Record<string, boolean> {
  try {
    const raw = readSecureJson<{ resourceToggles?: Record<string, unknown> }>(path);
    if (!raw) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw.resourceToggles ?? {})) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A rotated bearer token, persisted here so it survives a restart and overrides the seed token in
 * `.env`. Absent in older files, which simply means "use the env token". Read from the same file on
 * load; only ever present once the operator has rotated from the panel.
 */
export function loadManagedToken(path = dataPath("managed.json")): string | undefined {
  try {
    const raw = readSecureJson<{ token?: unknown }>(path);
    if (!raw) return undefined;
    return typeof raw.token === "string" && raw.token ? raw.token : undefined;
  } catch {
    return undefined;
  }
}

/** The panel-defined sidebar order: MCP names, first to last. Absent until the user first arranges
 *  the list — which is what an older file means too — and the reader then falls back to name order.
 *  Names of MCPs that no longer exist are harmless: the reader only uses this to rank what IS
 *  registered. */
export function loadOrder(path = dataPath("managed.json")): string[] {
  try {
    const raw = readSecureJson<{ order?: unknown }>(path);
    if (!raw) return [];
    return Array.isArray(raw.order) ? raw.order.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The group every MCP belongs to until it is put somewhere else.
 *
 * It is deliberately NOT stored: an MCP in the default group has no entry in `mcpGroups`, so a file
 * written before groups existed already means "everything is in default" and needs no migration.
 * The name is reserved — a custom group may not take it, because it is the sink a deleted group's
 * members fall back into and nothing may leave an MCP without a home.
 */
export const DEFAULT_GROUP = "default";

/** Case-insensitive, so "Docs" and "docs" cannot both exist and read as two groups. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The user's custom sidebar groups, in the order they are shown. `default` is never in here — it is
 * implicit and always rendered first. Absent in older files, which simply means "no groups yet".
 */
export function loadGroups(path = dataPath("managed.json")): string[] {
  try {
    const raw = readSecureJson<{ groups?: unknown }>(path);
    if (!raw) return [];
    if (!Array.isArray(raw.groups)) return [];
    return raw.groups.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * Which group each MCP is in, keyed by MCP name — a sparse map: an absent name is in `default`.
 *
 * Keyed by name rather than held on the ServerDef for the same reason as disabledTools: MCPs defined
 * in gateway.config.json have no managed entry to hang a field on, and those are exactly the ones a
 * user wants to organize.
 */
export function loadMcpGroups(path = dataPath("managed.json")): Record<string, string> {
  try {
    const raw = readSecureJson<{ mcpGroups?: Record<string, unknown> }>(path);
    if (!raw) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.mcpGroups ?? {})) {
      if (typeof v === "string" && v.trim() !== "") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** A named bearer token: the secret a client presents, plus a human label to tell clients apart. */
export interface TokenRec {
  id: string;
  label: string;
  secret: string;
  createdAt: string;
}

/** The named-token set, persisted so created / rotated / revoked tokens survive a restart. */
export function loadTokens(path = dataPath("managed.json")): TokenRec[] {
  try {
    const raw = readSecureJson<{ tokens?: unknown }>(path);
    if (!raw) return [];
    const arr = Array.isArray(raw.tokens) ? raw.tokens : [];
    return arr
      .map((t: any): TokenRec | null => {
        if (!t || typeof t.id !== "string" || typeof t.label !== "string" || typeof t.secret !== "string") return null;
        return { id: t.id, label: t.label, secret: t.secret, createdAt: typeof t.createdAt === "string" ? t.createdAt : "" };
      })
      .filter((t): t is TokenRec => t !== null);
  } catch {
    return [];
  }
}

/** Persists user-added MCPs so they survive a gateway restart. */
/**
 * Per-MCP run/stop state for CONFIG-file MCPs, keyed by MCP name.
 *
 * A managed MCP carries its own `enabled` on its entry; a config MCP has no entry to carry one, and
 * gateway.config.json is the user's committed file, which the panel does not rewrite. Without this,
 * Stop on a config MCP held only until the next boot, where the config loop started it again — the
 * button looked like it had worked and silently had not. Absent in older files: everything runs.
 */
export function loadMcpEnabled(path = dataPath("managed.json")): Record<string, boolean> {
  try {
    const raw = readSecureJson<{ mcpEnabled?: Record<string, unknown> }>(path);
    if (!raw) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw.mcpEnabled ?? {})) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export class ManagedStore {
  private entries: ManagedEntry[];
  private toolToggles: Record<string, string[]>;
  private resourceToggles: Record<string, boolean>;
  private tokens: TokenRec[];
  private order: string[];
  private groups: string[];
  private mcpGroups: Record<string, string>;
  private mcpEnabled: Record<string, boolean>;

  constructor(private path = dataPath("managed.json")) {
    this.entries = loadManaged(path);
    this.toolToggles = loadToolToggles(path);
    this.resourceToggles = loadResourceToggles(path);
    this.tokens = loadTokens(path);
    this.order = loadOrder(path);
    this.groups = loadGroups(path);
    this.mcpGroups = loadMcpGroups(path);
    this.mcpEnabled = loadMcpEnabled(path);
  }

  all(): ManagedEntry[] {
    return this.entries.map((e) => ({ ...e, def: { ...e.def } }));
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name);
  }

  add(e: ManagedEntry): void {
    if (this.has(e.name)) throw new Error(`managed MCP already exists: ${e.name}`);
    this.entries.push(e);
    this.persist();
  }

  /** Upsert a config-file MCP override (persisted here so the committed gateway.config.json keeps its ${ENV} refs). */
  upsertOverride(name: string, def: ServerDef): void {
    const existing = this.entries.find((x) => x.name === name);
    if (existing) { existing.def = def; existing.override = true; }
    else {
      // The override inherits the run/stop state the user already chose for this name, rather than
      // resetting it — an edit that flipped a stopped MCP back on read as the panel ignoring the Stop.
      this.entries.push({ name, def, enabled: this.mcpEnabled[name] ?? true, override: true });
      delete this.mcpEnabled[name];
    }
    this.persist();
  }

  remove(name: string): void {
    this.entries = this.entries.filter((e) => e.name !== name);
    this.order = this.order.filter((n) => n !== name); // a deleted MCP holds no sidebar slot
    delete this.mcpGroups[name]; // ...nor a group membership
    delete this.mcpEnabled[name]; // ...nor a run/stop state
    this.persist();
  }

  rename(oldName: string, newName: string): void {
    const e = this.entries.find((x) => x.name === oldName);
    if (e) {
      e.name = newName;
      this.persist();
    }
    // Keep the panel order pointing at the live name, so a rename does not shuffle the sidebar.
    if (this.order.includes(oldName)) {
      this.order = this.order.map((n) => (n === oldName ? newName : n));
      this.persist();
    }
    // Same for its group, so a rename does not silently drop the MCP back into default.
    if (this.mcpGroups[oldName] !== undefined) {
      this.mcpGroups[newName] = this.mcpGroups[oldName];
      delete this.mcpGroups[oldName];
      this.persist();
    }
    // And for its run/stop state, so a renamed config MCP keeps honoring the panel's Stop.
    if (this.mcpEnabled[oldName] !== undefined) {
      this.mcpEnabled[newName] = this.mcpEnabled[oldName];
      delete this.mcpEnabled[oldName];
      this.persist();
    }
  }

  /** Replace a managed MCP's def (used by config edit). */
  updateDef(name: string, def: ServerDef): void {
    const e = this.entries.find((x) => x.name === name);
    if (e) {
      e.def = def;
      this.persist();
    }
  }

  setEnabled(name: string, enabled: boolean): void {
    const e = this.entries.find((x) => x.name === name);
    if (e) e.enabled = enabled;
    else this.mcpEnabled[name] = enabled; // a config MCP has no entry — the side-map is its state
    this.persist();
  }

  /** Run/stop state for any MCP: the managed entry's own flag, else the config-MCP side-map. */
  enabledFor(name: string): boolean | undefined {
    const e = this.entries.find((x) => x.name === name);
    return e ? e.enabled : this.mcpEnabled[name];
  }

  /** The tools a user has turned off for this MCP (empty when none / unknown). */
  disabledTools(name: string): string[] {
    return this.toolToggles[name] ?? [];
  }

  /** Persist a tool-toggle change for any MCP, config- or managed-sourced. */
  setDisabledTools(name: string, tools: string[]): void {
    if (tools.length) this.toolToggles[name] = tools;
    else delete this.toolToggles[name];
    this.persist();
  }

  /** Whether this MCP's resources are exposed. `undefined` when never toggled (use the default). */
  resourceEnabled(name: string): boolean | undefined {
    return this.resourceToggles[name];
  }

  /** Persist a resources on/off toggle for any MCP. */
  setResourceEnabled(name: string, on: boolean): void {
    this.resourceToggles[name] = on;
    this.persist();
  }

  /** All named bearer tokens (secrets included — this stays in-process, never sent to clients). */
  getTokens(): TokenRec[] {
    return this.tokens.map((t) => ({ ...t }));
  }

  /** The panel's sidebar order (a copy). Registered names missing from it are appended by the reader,
   *  in name order. Empty means the user has never arranged the list. */
  getOrder(): string[] {
    return [...this.order];
  }

  /** Persist the sidebar order. Duplicates collapse to their first slot; an empty list gives up the
   *  arrangement and restores the default name order. */
  setOrder(names: string[]): void {
    this.order = [...new Set(names.filter((n) => typeof n === "string" && n))];
    this.persist();
  }

  /** The user's custom sidebar groups, in order (a copy). `default` is implicit and not in here. */
  getGroups(): string[] {
    return [...this.groups];
  }

  /** The group this MCP is in. Unassigned — or assigned to a group since deleted — means default. */
  groupOf(name: string): string {
    const g = this.mcpGroups[name];
    return g && this.groups.some((x) => x === g) ? g : DEFAULT_GROUP;
  }

  /** Which group each MCP is in (a copy). Sparse: an absent name is in the default group. */
  getMcpGroups(): Record<string, string> {
    return { ...this.mcpGroups };
  }

  /**
   * Replace the whole custom-group list: this is create, delete and reorder in one call, matching
   * setOrder. A group dropped by omission is deleted, and its members fall back to the default group
   * rather than being stranded pointing at a name that no longer exists.
   */
  setGroups(names: string[]): void {
    const next: string[] = [];
    for (const raw of names) {
      if (typeof raw !== "string") continue;
      const name = raw.trim();
      if (!name) throw new Error("a group name cannot be empty");
      if (sameName(name, DEFAULT_GROUP)) throw new Error(`"${DEFAULT_GROUP}" is a reserved group name`);
      if (next.some((n) => sameName(n, name))) throw new Error(`duplicate group name: ${name}`);
      next.push(name);
    }
    this.groups = next;
    for (const [mcp, group] of Object.entries(this.mcpGroups)) {
      if (!next.some((n) => n === group)) delete this.mcpGroups[mcp];
    }
    this.persist();
  }

  /** Put an MCP in a group, or back into the default group with `null`. */
  setMcpGroup(name: string, group: string | null): void {
    if (group === null || sameName(group, DEFAULT_GROUP)) delete this.mcpGroups[name];
    else {
      const match = this.groups.find((n) => sameName(n, group));
      if (!match) throw new Error(`unknown group: ${group}`);
      this.mcpGroups[name] = match; // store the canonical casing, not what the caller typed
    }
    this.persist();
  }

  /** Rename a group in place, carrying its members with it and keeping its slot in the order. */
  renameGroup(from: string, to: string): void {
    const next = to.trim();
    if (!next) throw new Error("a group name cannot be empty");
    if (sameName(next, DEFAULT_GROUP)) throw new Error(`"${DEFAULT_GROUP}" is a reserved group name`);
    const i = this.groups.findIndex((n) => sameName(n, from));
    if (i < 0) throw new Error(`unknown group: ${from}`);
    if (this.groups.some((n, j) => j !== i && sameName(n, next))) throw new Error(`duplicate group name: ${next}`);

    const old = this.groups[i]!;
    this.groups[i] = next;
    for (const [mcp, group] of Object.entries(this.mcpGroups)) {
      if (group === old) this.mcpGroups[mcp] = next;
    }
    this.persist();
  }

  /** Delete a group. Its MCPs are not touched — they fall back into the default group. */
  removeGroup(name: string): void {
    const match = this.groups.find((n) => sameName(n, name));
    if (!match) return;
    this.groups = this.groups.filter((n) => n !== match);
    for (const [mcp, group] of Object.entries(this.mcpGroups)) {
      if (group === match) delete this.mcpGroups[mcp];
    }
    this.persist();
  }

  /** Replace the whole token set (create / rotate / revoke all persist through here). */
  saveTokens(next: TokenRec[]): void {
    this.tokens = next;
    this.persist();
  }

  /**
   * Write the file atomically, and tell the caller when it could not be written.
   *
   * Both halves matter here, and writeJsonAtomic carries the full reasoning: a torn managed.json
   * makes loadManaged() answer `[]`, silently discarding every managed MCP and every config
   * override, and a save that only logged let the admin API report 201 Created for an MCP whose
   * definition never reached the disk.
   */
  private persist(): void {
    writeSecureJson(this.path, {
      mcps: this.entries,
      disabledTools: this.toolToggles,
      resourceToggles: this.resourceToggles,
      // `undefined` is dropped by JSON.stringify, so a tokenless file keeps its old shape.
      tokens: this.tokens,
      ...(this.order.length ? { order: this.order } : {}),
      // Omitted while empty, so a panel that never made a group leaves the file exactly as it was.
      ...(this.groups.length ? { groups: this.groups } : {}),
      ...(Object.keys(this.mcpGroups).length ? { mcpGroups: this.mcpGroups } : {}),
      // Same convention: an older file with no key means "everything runs".
      ...(Object.keys(this.mcpEnabled).length ? { mcpEnabled: this.mcpEnabled } : {}),
    });
  }
}
