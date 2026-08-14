#!/usr/bin/env node
import { buildApp } from "./router.js";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { flushCalls, startCallRetention } from "./calls.js";
import { Registry, isLazy } from "./registry.js";
import { ManagedStore, loadManagedToken } from "./managed.js";
import { TokenManager } from "./token.js";
import { makeAdapter } from "./adapters/factory.js";
import { killOrphanMcps } from "./process-tree.js";
import { setProcPidFile, reapProcPids } from "./proc-pids.js";
import { TunnelStore } from "./tunnels/store.js";
import { TunnelManager } from "./tunnels/manager.js";
import { registryView } from "./tunnels/mcpmatch.js";
import { ensureFirstRun } from "./bootstrap.js";
import { dataPath } from "./datadir.js";
import { loginPath } from "./pathenv.js";

async function main() {
  // A detached `lmg start` (and Cursor's agent shell) often inherit a PATH that is missing
  // user-level bins — uv/uvx live in ~/.local/bin. Put them back before any proc MCP spawns.
  process.env.PATH = loginPath();

  // Create the data dir, seed a default config, and guarantee a token exists — before loadConfig
  // reads that token. A no-op on every boot after the first.
  ensureFirstRun();
  const cfg = loadConfig();

  // Reap proc-MCP children a PREVIOUS instance orphaned when it was hard-killed (task /End, crash)
  // before close() could tree-kill them. Read from a persisted ledger of spawned PIDs, so it catches
  // ANY proc command — not just the known packages the command-match sweep below covers. Runs before
  // any proc MCP of ours starts; a cheap file read (no PowerShell) when the ledger is empty.
  setProcPidFile(dataPath(".proc-pids.json"));
  await reapProcPids(process.pid);

  // Backstop: a command-line sweep for the known MCP packages, in case the ledger missed one (a proc
  // child from a config since removed). No-op off Windows / when none match.
  if (Object.values(cfg.servers).some((s) => s.type === "proc")) {
    await killOrphanMcps(process.pid);
  }

  const registry = new Registry(15000);
  const store = new ManagedStore(dataPath("managed.json"));

  // Tunnels come up before the MCPs are registered because several MCPs connect through them, and
  // that is simply the natural order — NOT a dependency. A rule that fails to start is logged and
  // every MCP starts regardless; nothing here blocks or delays an MCP.
  const tunnelStore = new TunnelStore(dataPath("tunnels.json"), cfg.port);
  const tunnels = new TunnelManager(tunnelStore, { mcps: registryView(registry) });
  for (const r of await tunnels.startEnabled()) {
    if (!r.ok) log("warn", "tunnel autostart failed", { rule: r.name, err: r.error });
  }

  // Register + start every config-defined MCP; one failure must not take down the rest.
  for (const [name, def] of Object.entries(cfg.servers)) {
    try {
      // Apply persisted tool toggles before the adapter captures the def, so a toggle survives restart.
      def.disabledTools = store.disabledTools(name);
      const adapter = makeAdapter(def, name);
      const r = store.resourceEnabled(name);
      if (r !== undefined && adapter.resourceToggle) adapter.resourceToggle.on = r;
      registry.register(name, "config", def, adapter);
      // A lazy MCP (a proc by default, anything with lazy:true) stays idle at boot — the first
      // client request wakes it (see Registry.ensureStarted), which is the memory the gateway
      // exists to save: an idle npx/uvx child is 50-150MB of nothing.
      if (isLazy(def)) log("info", "config mcp idle (starts on first request)", { name, type: def.type });
      else {
        await registry.start(name);
        log("info", "config mcp ready", { name, type: def.type });
      }
    } catch (err) {
      log("error", "config mcp init failed", { name, err: (err as Error).message });
    }
  }

  // Restore user-added MCPs from managed.json; start the ones marked enabled.
  // An `override` entry replaces a config-file MCP's def (edits to config MCPs persist here).
  for (const m of store.all()) {
    if (m.override && registry.has(m.name)) {
      try {
        await registry.updateDef(m.name, m.def, makeAdapter(m.def, m.name));
        log("info", "config mcp override applied", { name: m.name, type: m.def.type });
      } catch (err) {
        log("error", "config mcp override failed", { name: m.name, err: (err as Error).message });
      }
      continue;
    }
    if (registry.has(m.name)) continue; // never overwrite a config MCP with a non-override
    try {
      m.def.disabledTools = store.disabledTools(m.name);
      const adapter = makeAdapter(m.def, m.name);
      const r = store.resourceEnabled(m.name);
      if (r !== undefined && adapter.resourceToggle) adapter.resourceToggle.on = r;
      registry.register(m.name, "managed", m.def, adapter);
      // Same lazy rule as config MCPs at boot: idle until first request. A proc added from the panel
      // mid-run still starts immediately (that path is an explicit start, not this restore).
      if (m.enabled && !isLazy(m.def)) await registry.start(m.name);
      log("info", "managed mcp ready", { name: m.name, type: m.def.type, enabled: m.enabled });
    } catch (err) {
      log("error", "managed mcp init failed", { name: m.name, err: (err as Error).message });
    }
  }

  registry.startTimer();

  // Named per-client tokens, seeded from the existing secret so clients already configured keep
  // authenticating (as the "default" token). A pre-multi-token rotation in managed.json takes
  // precedence over the .env seed.
  const tokens = new TokenManager(store, loadManagedToken(dataPath("managed.json")) ?? cfg.token);
  const app = buildApp(registry, tokens, store, { user: cfg.user, pass: cfg.pass }, cfg.tokenEnv, {
    store: tunnelStore,
    manager: tunnels,
  });
  const httpServer = app.listen(cfg.port, cfg.host, () => {
    log("info", "gateway listening", { host: cfg.host, port: cfg.port, paths: registry.names() });
  });
  // A listen failure (EADDRINUSE from a stray second instance, or a restart racing the previous
  // instance's port release) reaches the server as an 'error' EVENT, not as a rejected promise —
  // so main().catch() never sees it and node printed a raw stack instead, with nothing in the log
  // to say why. The event lands on a later tick, so attaching here is in time.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    log("error", "listen failed", { host: cfg.host, port: cfg.port, code: err.code, err: err.message });
    process.exit(1);
  });

  // Retention runs on a boot sweep plus an hourly timer: the per-append check inside recordCall only
  // ever fires for an MCP still being called, which is the opposite of the log that needs ageing out.
  const stopRetention = startCallRetention();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // a second signal shouldn't restart the sequence
    shuttingDown = true;
    registry.stopTimer();
    stopRetention();
    log("info", "shutting down");
    // Stop accepting, then drop live connections. Waiting on close()'s callback used to hang forever:
    // a connected MCP client holds the GET notification stream open, and close() waits for every
    // active connection to end — so the gateway acknowledged SIGTERM and then never exited.
    httpServer.close();
    httpServer.closeAllConnections();
    const force = setTimeout(() => process.exit(1), 3000); // a wedged DB driver must not block exit
    force.unref();
    // Tunnels first: this releases every local port, and it leaves each rule's `enabled` flag alone
    // so the next boot brings back exactly the set that was running.
    await tunnels.closeAll();
    await registry.closeAll();
    await flushCalls(); // the last calls before a restart are the ones worth having on disk
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log("error", "fatal", { err: err.message });
  process.exit(1);
});
