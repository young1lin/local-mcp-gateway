import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { log } from "../log.js";
import { dataPath } from "../datadir.js";
import { readSecureJson, writeSecureJson } from "../secure/statefile.js";
import type { GroupKind, RuleDef, SshConnDef } from "./types.js";

export function newId(): string {
  return randomUUID();
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function num(v: unknown, fallback = NaN): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function isPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Input shapes: the store assigns ids, and every optional field has a default. */
export type ConnInput = Omit<SshConnDef, "id" | "group"> & { id?: string; group?: string };
export type RuleInput = Omit<RuleDef, "id" | "autoReconnect" | "reconnectInterval" | "enabled" | "mcps" | "group"> &
  Partial<Pick<RuleDef, "id" | "autoReconnect" | "reconnectInterval" | "enabled" | "mcps" | "group">>;

/**
 * Persists SSH connections and forwarding rules to tunnels.json.
 *
 * Pure data: it validates and stores, and knows nothing about sockets or ssh2 — which is what makes
 * every rule in here testable without a network.
 */
/** The group name every ungrouped row belongs to. Reserved: a stored group may not use it. */
export const DEFAULT_GROUP = "default";

export class TunnelStore {
  private conns: SshConnDef[] = [];
  private ruleList: RuleDef[] = [];
  /** Custom group names per list, in panel order. The default group is implicit and never stored. */
  private groupNames: Record<GroupKind, string[]> = { rules: [], connections: [] };

  /** `gatewayPort` is rejected as a local port, since binding it could never work. */
  constructor(private path = dataPath("tunnels.json"), private gatewayPort = 0) {
    this.load();
  }

  private load(): void {
    let raw: any;
    try {
      raw = readSecureJson<any>(this.path);
    } catch (err) {
      log("warn", "tunnels load failed", { err: (err as Error).message, path: this.path });
      return;
    }
    if (!raw) return;
    for (const c of Array.isArray(raw?.connections) ? raw.connections : []) {
      if (!c || typeof c.id !== "string" || !str(c.name) || !str(c.host)) continue;
      this.conns.push({
        id: c.id,
        name: str(c.name),
        host: str(c.host),
        port: isPort(num(c.port)) ? num(c.port) : 22,
        username: str(c.username),
        authType: c.authType === "password" ? "password" : "key",
        keyPath: typeof c.keyPath === "string" ? c.keyPath : undefined,
        passphrase: typeof c.passphrase === "string" ? c.passphrase : undefined,
        password: typeof c.password === "string" ? c.password : undefined,
        hostKey: str(c.hostKey) || undefined,
        group: str(c.group) || undefined,
      });
    }
    for (const r of Array.isArray(raw?.rules) ? raw.rules : []) {
      // A rule whose connectionId is unknown is KEPT: it surfaces as `error: unknown connection`
      // rather than vanishing, so one bad hand-edit cannot silently discard the other 17 rules.
      if (!r || typeof r.id !== "string" || !str(r.name) || !isPort(num(r.localPort))) continue;
      this.ruleList.push({
        id: r.id,
        name: str(r.name),
        connectionId: str(r.connectionId),
        localPort: num(r.localPort),
        targetHost: str(r.targetHost) || "127.0.0.1",
        targetPort: isPort(num(r.targetPort)) ? num(r.targetPort) : num(r.localPort),
        remark: str(r.remark),
        autoReconnect: r.autoReconnect === true,
        reconnectInterval: Math.max(1, num(r.reconnectInterval, 10) || 10),
        enabled: r.enabled === true,
        mcps: Array.isArray(r.mcps) ? r.mcps.filter((m: unknown): m is string => typeof m === "string" && !!m) : [],
        group: str(r.group) || undefined,
      });
    }
    const rawGroups = raw as Record<string, unknown>;
    const groupList = (key: string): string[] => {
      const names = rawGroups?.[key];
      return Array.isArray(names)
        ? names.filter((n): n is string => typeof n === "string" && !!str(n) && str(n) !== DEFAULT_GROUP)
        : [];
    };
    this.groupNames.rules = groupList("ruleGroups");
    this.groupNames.connections = groupList("connGroups");
  }

  private persist(): void {
    writeSecureJson(this.path, {
      connections: this.conns,
      rules: this.ruleList,
      ruleGroups: this.groupNames.rules,
      connGroups: this.groupNames.connections,
    });
  }

  isEmpty(): boolean {
    return !this.conns.length && !this.ruleList.length;
  }

  /** True when there is no file at all — the signal for a first-run import. */
  isFresh(): boolean {
    return !existsSync(this.path);
  }

  connections(): SshConnDef[] {
    return this.conns.map((c) => ({ ...c }));
  }
  rules(): RuleDef[] {
    return this.ruleList.map((r) => ({ ...r, mcps: [...r.mcps] }));
  }
  connection(id: string): SshConnDef | undefined {
    const c = this.conns.find((x) => x.id === id);
    return c ? { ...c } : undefined;
  }
  rule(id: string): RuleDef | undefined {
    const r = this.ruleList.find((x) => x.id === id);
    return r ? { ...r, mcps: [...r.mcps] } : undefined;
  }
  rulesForConnection(id: string): RuleDef[] {
    return this.ruleList.filter((r) => r.connectionId === id).map((r) => ({ ...r, mcps: [...r.mcps] }));
  }

  // --- validation -------------------------------------------------------------------------------

  private validConn(input: ConnInput): SshConnDef {
    const name = str(input.name);
    if (!name) throw new Error("name is required");
    const host = str(input.host);
    if (!host) throw new Error("host is required");
    const username = str(input.username);
    if (!username) throw new Error("username is required");
    const port = num(input.port, 22);
    if (!isPort(port)) throw new Error(`invalid SSH port: ${input.port}`);
    const authType = input.authType === "password" ? "password" : "key";
    const out: SshConnDef = { id: input.id ?? newId(), name, host, port, username, authType };
    if (authType === "key") {
      const keyPath = str(input.keyPath);
      if (!keyPath) throw new Error("a private key path is required for key authentication");
      out.keyPath = keyPath;
      if (String(input.passphrase ?? "")) out.passphrase = String(input.passphrase);
    } else {
      if (!String(input.password ?? "")) throw new Error("a password is required for password authentication");
      out.password = String(input.password);
    }
    if (str(input.hostKey)) out.hostKey = str(input.hostKey);
    if (str(input.group)) out.group = str(input.group);
    return out;
  }

  private validRule(input: RuleInput, selfId?: string): RuleDef {
    const name = str(input.name);
    if (!name) throw new Error("name is required");
    const connectionId = str(input.connectionId);
    if (!this.conns.some((c) => c.id === connectionId)) {
      throw new Error(`unknown SSH connection: ${connectionId || "(none selected)"}`);
    }
    const localPort = num(input.localPort);
    if (!isPort(localPort)) throw new Error(`invalid local port: ${input.localPort}`);
    if (this.gatewayPort && localPort === this.gatewayPort) {
      throw new Error(`local port ${localPort} is the gateway's own port`);
    }
    const clash = this.ruleList.find((r) => r.localPort === localPort && r.id !== selfId);
    if (clash) throw new Error(`local port ${localPort} is already used by '${clash.name}'`);
    const targetPort = num(input.targetPort);
    if (!isPort(targetPort)) throw new Error(`invalid target port: ${input.targetPort}`);
    const def: RuleDef = {
      id: input.id ?? selfId ?? newId(),
      name,
      connectionId,
      localPort,
      targetHost: str(input.targetHost) || "127.0.0.1",
      targetPort,
      remark: str(input.remark),
      autoReconnect: input.autoReconnect === true,
      reconnectInterval: Math.max(1, num(input.reconnectInterval, 10) || 10),
      enabled: input.enabled === true,
      mcps: Array.isArray(input.mcps) ? input.mcps.filter((m) => typeof m === "string" && !!m) : [],
    };
    if (str(input.group)) def.group = str(input.group);
    return def;
  }

  // --- mutations --------------------------------------------------------------------------------

  addConnection(input: ConnInput): SshConnDef {
    const def = this.validConn(input);
    if (this.conns.some((c) => c.id === def.id)) throw new Error(`connection already exists: ${def.id}`);
    this.conns.push(def);
    this.persist();
    return { ...def };
  }

  updateConnection(id: string, input: ConnInput): SshConnDef {
    const i = this.conns.findIndex((c) => c.id === id);
    if (i < 0) throw new Error(`unknown SSH connection: ${id}`);
    const def = this.validConn({ ...input, id });
    // A learned host key survives an edit unless the host itself moved — re-approving a fingerprint
    // because a username was corrected would train the user to click through the one prompt that
    // exists to stop a man-in-the-middle.
    if (!def.hostKey && def.host === this.conns[i].host && def.port === this.conns[i].port) {
      def.hostKey = this.conns[i].hostKey;
    }
    if (!def.group) def.group = this.conns[i].group;
    this.conns[i] = def;
    this.persist();
    return { ...def };
  }

  removeConnection(id: string): void {
    const used = this.ruleList.filter((r) => r.connectionId === id);
    if (used.length) {
      throw new Error(`connection is still used by: ${used.map((r) => r.name).join(", ")}`);
    }
    const before = this.conns.length;
    this.conns = this.conns.filter((c) => c.id !== id);
    if (this.conns.length !== before) this.persist();
  }

  addRule(input: RuleInput): RuleDef {
    const def = this.validRule(input);
    if (this.ruleList.some((r) => r.id === def.id)) throw new Error(`rule already exists: ${def.id}`);
    this.ruleList.push(def);
    this.persist();
    return { ...def, mcps: [...def.mcps] };
  }

  updateRule(id: string, input: RuleInput): RuleDef {
    const i = this.ruleList.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`unknown rule: ${id}`);
    // `enabled` is runtime state owned by the manager, not something an edit may silently flip;
    // `mcps` omitted from the input keeps the stored links — the same courtesy `group` gets below.
    // (An explicit [] still clears them; a create with no mcps still starts from [].)
    const def = this.validRule({
      ...input,
      ...(input.mcps === undefined ? { mcps: this.ruleList[i].mcps } : {}),
      id,
      enabled: this.ruleList[i].enabled,
    }, id);
    if (!def.group) def.group = this.ruleList[i].group;
    this.ruleList[i] = def;
    this.persist();
    return { ...def, mcps: [...def.mcps] };
  }

  removeRule(id: string): void {
    const before = this.ruleList.length;
    this.ruleList = this.ruleList.filter((r) => r.id !== id);
    if (this.ruleList.length !== before) this.persist();
  }

  setEnabled(id: string, enabled: boolean): void {
    const r = this.ruleList.find((x) => x.id === id);
    if (!r || r.enabled === enabled) return;
    r.enabled = enabled;
    this.persist();
  }

  /** Drop a connection's learned host key (a trust reset): the next connect learns it afresh.
   *  updateConnection cannot express this — it deliberately re-adopts the old key when host/port
   *  are unchanged, which would silently undo the clear on the very next edit. */
  clearHostKey(id: string): void {
    const c = this.conns.find((x) => x.id === id);
    if (!c || !c.hostKey) return;
    c.hostKey = undefined;
    this.persist();
  }

  setHostKey(id: string, fingerprint: string): void {
    const c = this.conns.find((x) => x.id === id);
    if (!c || c.hostKey === fingerprint) return;
    c.hostKey = fingerprint;
    this.persist();
  }

  /** Replace everything at once (the first-run import). */
  replaceAll(conns: SshConnDef[], rules: RuleDef[]): void {
    this.conns = conns;
    this.ruleList = rules;
    this.persist();
  }

  // --- groups and order --------------------------------------------------------------------------

  private rowsOf(kind: GroupKind): Array<SshConnDef | RuleDef> {
    return kind === "rules" ? this.ruleList : this.conns;
  }

  groupsOf(kind: GroupKind): string[] {
    return [...this.groupNames[kind]];
  }

  /** Replace the whole group-name list: create, reorder and delete are all "here is the new list".
   *  Deleting a group strands its members in the implicit default rather than pointing at nothing. */
  setGroups(kind: GroupKind, names: unknown): string[] {
    if (!Array.isArray(names)) throw new Error("groups must be an array");
    const clean = [...new Set(names.map((n) => str(n)).filter((n) => n && n !== DEFAULT_GROUP))];
    this.groupNames[kind] = clean;
    for (const row of this.rowsOf(kind)) {
      if (row.group && !clean.includes(row.group)) row.group = undefined;
    }
    this.persist();
    return this.groupsOf(kind);
  }

  renameGroup(kind: GroupKind, from: string, to: string): { groups: string[]; moved: number } {
    const src = str(from);
    const dst = str(to);
    if (!src || !dst) throw new Error("from and to are required");
    if (dst === DEFAULT_GROUP) throw new Error("the default group cannot be recreated under a new name");
    if (!this.groupNames[kind].includes(src)) throw new Error("unknown group: " + src);
    if (src !== dst && this.groupNames[kind].includes(dst)) throw new Error("group already exists: " + dst);
    this.groupNames[kind] = this.groupNames[kind].map((n) => (n === src ? dst : n));
    let moved = 0;
    for (const row of this.rowsOf(kind)) {
      if (row.group === src) { row.group = dst; moved++; }
    }
    this.persist();
    return { groups: this.groupsOf(kind), moved };
  }

  /** Put one row in a group. An empty name (or the reserved default) means the implicit default. */
  setGroup(kind: GroupKind, id: string, group: unknown): string {
    const name = str(group);
    if (name && name !== DEFAULT_GROUP && !this.groupNames[kind].includes(name)) {
      throw new Error("unknown group: " + name);
    }
    const row = this.rowsOf(kind).find((x) => x.id === id);
    if (!row) throw new Error("unknown " + (kind === "rules" ? "rule" : "SSH connection") + ": " + id);
    row.group = name && name !== DEFAULT_GROUP ? name : undefined;
    this.persist();
    return row.group ?? DEFAULT_GROUP;
  }

  /** Impose a full order on one list. Rows the caller omitted keep their relative order after the
   *  mentioned ones, so a stale panel reorder cannot drop or duplicate anything. */
  reorder(kind: GroupKind, ids: unknown): void {
    if (!Array.isArray(ids)) throw new Error("ids must be an array");
    const order = ids.filter((x): x is string => typeof x === "string");
    const rank = (id: string) => {
      const i = order.indexOf(id);
      return i < 0 ? order.length : i;
    };
    const sorted = [...this.rowsOf(kind)].sort((a, b) => rank(a.id) - rank(b.id));
    if (kind === "rules") this.ruleList = sorted as RuleDef[];
    else this.conns = sorted as SshConnDef[];
    this.persist();
  }

  // --- MCP link maintenance ---------------------------------------------------------------------

  renameMcp(from: string, to: string): void {
    let touched = false;
    for (const r of this.ruleList) {
      const i = r.mcps.indexOf(from);
      if (i >= 0) { r.mcps[i] = to; touched = true; }
    }
    if (touched) this.persist();
  }

  forgetMcp(name: string): void {
    let touched = false;
    for (const r of this.ruleList) {
      const i = r.mcps.indexOf(name);
      if (i >= 0) { r.mcps.splice(i, 1); touched = true; }
    }
    if (touched) this.persist();
  }
}
