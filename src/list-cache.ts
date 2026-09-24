import { createHash } from "node:crypto";
import type { Prompt, Resource, Tool } from "@modelcontextprotocol/server";
import type { ServerDef } from "./config.js";
import { readSecureJson, writeSecureJson } from "./secure/statefile.js";
import { log } from "./log.js";

/**
 * What a lazy MCP's child answered to the list requests the last time it ran — enough to serve
 * `initialize`, `tools/list`, `prompts/list` and `resources/list` without spawning it again.
 * `undefined` means the list was not captured (the child lacks the capability, or it is hidden).
 */
export interface ListSnapshot {
  tools: Tool[];
  prompts?: Prompt[];
  resources?: Resource[];
}

interface CacheRow {
  /** Hash of the definition the snapshot was taken under — a config edit invalidates it. */
  defHash: string;
  savedAt: string;
  snapshot: ListSnapshot;
}

/** The definition as authored (`${ENV}` references unresolved, so no secret feeds the hash).
 *  `disabledTools` is left out: boot copies the persisted toggles onto the def while a panel add does
 *  not, so keeping it made the snapshot taken right after an add miss on the next boot. */
export function defHash(def: ServerDef): string {
  const authored: ServerDef = { ...def };
  delete authored.disabledTools;
  return createHash("sha256").update(JSON.stringify(authored)).digest("hex");
}

/**
 * The persisted list snapshots of lazy MCPs, one sealed file for all of them (tool schemas are not
 * secrets, but every state file here is sealed — see secure/statefile.ts). Read once, then served
 * from memory; written after each successful start of a lazy MCP.
 */
export class ListCache {
  private rows?: Record<string, CacheRow>;

  constructor(private path: string) {}

  /** The snapshot for `name`, if one was taken under exactly this definition. */
  get(name: string, def: ServerDef): ListSnapshot | undefined {
    const row = this.load()[name];
    return row && row.defHash === defHash(def) ? row.snapshot : undefined;
  }

  set(name: string, def: ServerDef, snapshot: ListSnapshot): void {
    this.load()[name] = { defHash: defHash(def), savedAt: new Date().toISOString(), snapshot };
    this.save();
  }

  /** Follow a rename: the definition is unchanged, so the snapshot stays valid under the new name. */
  rename(oldName: string, newName: string): void {
    const rows = this.load();
    if (!rows[oldName]) return;
    rows[newName] = rows[oldName];
    delete rows[oldName];
    this.save();
  }

  delete(name: string): void {
    const rows = this.load();
    if (!rows[name]) return;
    delete rows[name];
    this.save();
  }

  private load(): Record<string, CacheRow> {
    if (this.rows) return this.rows;
    try {
      const raw = readSecureJson<Record<string, CacheRow>>(this.path);
      this.rows = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch (err) {
      // A cache that cannot be read is an empty cache: every lazy MCP simply wakes as before.
      log("warn", "list cache unreadable; starting empty", { path: this.path, err: (err as Error).message });
      this.rows = {};
    }
    return this.rows;
  }

  private save(): void {
    try {
      writeSecureJson(this.path, this.rows ?? {});
    } catch (err) {
      log("warn", "list cache write failed", { path: this.path, err: (err as Error).message });
    }
  }
}
