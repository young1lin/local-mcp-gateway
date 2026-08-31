import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import type { TunnelStore } from "./store.js";
import type { RuleDef, SshConnDef } from "./types.js";

/** Where forward-port keeps its config on Windows. */
export function forwardPortConfigPath(): string {
  const appData = process.env.APPDATA ?? "";
  return appData ? join(appData, "forward-port", "config.json") : "";
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

/**
 * One-shot import of forward-port's config, read-only.
 *
 * Every rule arrives STOPPED on purpose: forward-port.exe may still be running and holding the
 * local ports, and a gateway that started every imported tunnel on boot would collide with it and
 * report a wall of failures on its first run. The user starts them once the old tool is retired.
 */
export function importForwardPort(
  store: TunnelStore,
  path = forwardPortConfigPath(),
): { connections: number; rules: number } | null {
  if (!path || !existsSync(path)) return null;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    log("warn", "forward-port import failed to parse", { err: (err as Error).message, path });
    return null;
  }

  const conns: SshConnDef[] = [];
  for (const c of Array.isArray(raw?.connections) ? raw.connections : []) {
    if (!c || typeof c.id !== "string" || !c.name || !c.host) continue;
    const authType = c.auth_type === "password" ? "password" : "key";
    const def: SshConnDef = {
      id: c.id,
      name: String(c.name),
      host: String(c.host),
      port: num(c.port, 22),
      username: String(c.username ?? ""),
      authType,
    };
    if (authType === "key") {
      def.keyPath = String(c.key_path || "~/.ssh/id_rsa");
      if (c.key_passphrase) def.passphrase = String(c.key_passphrase);
    } else {
      def.password = String(c.password ?? "");
    }
    conns.push(def);
  }

  const rules: RuleDef[] = [];
  const seenPorts = new Set<number>();
  for (const t of Array.isArray(raw?.tunnels) ? raw.tunnels : []) {
    if (!t || typeof t.id !== "string" || !t.name) continue;
    const localPort = num(t.local_port, 0);
    if (!localPort) continue;
    // The old tool tolerated both of these; this store does not, and one bad row must not abort the
    // other 17 imports — so they are skipped with a line in the log rather than thrown.
    if (!conns.some((c) => c.id === t.connection_id)) {
      log("warn", "import skipped rule with unknown connection", { rule: String(t.name) });
      continue;
    }
    if (seenPorts.has(localPort)) {
      log("warn", "import skipped rule with a duplicate local port", { rule: String(t.name), localPort });
      continue;
    }
    seenPorts.add(localPort);
    rules.push({
      id: t.id,
      name: String(t.name),
      connectionId: String(t.connection_id),
      localPort,
      targetHost: String(t.target_host || "127.0.0.1"),
      targetPort: num(t.target_port, localPort),
      remark: String(t.remark ?? ""),
      autoReconnect: t.auto_reconnect === true,
      reconnectInterval: Math.max(1, num(t.reconnect_interval, 10)),
      enabled: false,
      mcps: [],
    });
  }

  if (!conns.length && !rules.length) return null;
  store.replaceAll(conns, rules);
  log("info", "tunnels imported from forward-port", { connections: conns.length, rules: rules.length, path });
  return { connections: conns.length, rules: rules.length };
}
