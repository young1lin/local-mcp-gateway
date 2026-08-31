import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, dataPath } from "./datadir.js";
import { chmodPrivate, mkdirPrivate } from "./privfs.js";
import { skillDir } from "./skilldir.js";
import { readSecureJson, writeSecureJson } from "./secure/statefile.js";
import { envStorePath, parseEnvText, readEnvStore, setEnvDefault, writeEnvStore } from "./secure/envstore.js";
import { DEFAULT_PORT, asListenPort, envListenPort } from "./port.js";

/**
 * The minimal config seeded on first run: one 'echo' MCP so the panel has a working endpoint
 * before any database is configured, and nothing else. The richer 'gateway.config.example.json'
 * stays shipped for manual cp use (the README points at it); a zero-config first run wants no
 * row of "down" database templates the user never asked for. The skill carries the database
 * examples instead, where they are actually useful.
 *
 * Everything this file writes is SEALED on arrival (see secure/statefile.ts): the seed config,
 * the env store holding the token, and any migrated repo-local state. A plaintext file dropped
 * into the data dir by hand is adopted and sealed on the next read.
 */
function seedConfig() {
  return {
    port: envListenPort() ?? DEFAULT_PORT,
    host: "127.0.0.1",
    tokenEnv: "MCP_GATEWAY_TOKEN",
    servers: {
      echo: {
        type: "echo",
        description: "Built-in no-op — a working endpoint before any database is configured.",
      },
    },
  };
}

/** The skill's location in the package (see src/skilldir.ts, which cli.ts shares). */
const SKILL_PATH = join(skillDir(), "SKILL.md");

/** What the run that just bootstrapped should tell the operator (secrets only on the run that
 *  created them, so a restart never re-prints a token into a log). */
interface FirstRunReport {
  dataDir: string;
  /** The token, only when this run generated it. */
  newToken?: string;
  /** True when a repo-local .env / config was folded into the sealed stores. */
  migrated: boolean;
  /** True when the data dir did not exist before this call. */
  created: boolean;
}

/** Does this text look like IT BELONGS to a gateway setup? Same gate as the config below: without
 *  it, ANY directory's .env (a random Node project full of database passwords) would be adopted. */
function looksLikeGatewayEnv(text: string): boolean {
  return /^MCP_GATEWAY_TOKEN=/m.test(text);
}

/** A gateway config carries tokenEnv + servers; anything else is not ours to adopt. */
function looksLikeGatewayConfigShape(parsed: unknown): boolean {
  return !!parsed && typeof parsed === "object" && "tokenEnv" in parsed && "servers" in parsed;
}

/**
 * Fold a repo-local .env into the sealed env store — PARSED, never file-copied, so no plaintext
 * lands in the data dir even briefly. First run only: an existing env.json always wins.
 */
function migrateEnvOnce(): boolean {
  const repoEnv = join(process.cwd(), ".env");
  if (existsSync(envStorePath()) || !existsSync(repoEnv)) return false;
  try {
    const text = readFileSync(repoEnv, "utf8");
    if (!looksLikeGatewayEnv(text)) return false;
    const pairs = parseEnvText(text);
    if (!Object.keys(pairs).length) return false;
    writeEnvStore(pairs);
    return true;
  } catch {
    return false;
  }
}

/** Adopt a repo-local gateway.config.json once — sealed on arrival, never plaintext on disk. */
function migrateConfigOnce(): boolean {
  const repoPath = join(process.cwd(), "gateway.config.json");
  const dataFile = dataPath("gateway.config.json");
  if (existsSync(dataFile) || !existsSync(repoPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(repoPath, "utf8"));
    if (!looksLikeGatewayConfigShape(parsed)) return false;
    writeSecureJson(dataFile, parsed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make the gateway runnable with no prior setup: create the data dir, fold any repo-local state
 * in once (sealed), seed a default config, and guarantee a token exists in the sealed env store.
 * Safe to call every boot — it only acts on what is missing.
 *
 * Runs at the top of main(), before loadConfig(), because loadConfig injects the env store this
 * seeds into process.env.
 */
export function ensureFirstRun(): FirstRunReport {
  const dir = dataDir();
  const created = !existsSync(dir);
  mkdirPrivate(dir);

  // Pull an existing repo-local setup in once (the user's current .env / config), so an upgrade
  // does not throw away a working token and hand the operator a blank slate. Both are attempted —
  // the old '||' short-circuited past the config copy once the .env copy succeeded, silently
  // replacing the user's real gateway.config.json with the echo-only seed.
  const migratedEnv = migrateEnvOnce();
  const migratedCfg = migrateConfigOnce();
  const migrated = migratedEnv || migratedCfg;

  // Seed a default config when none exists (after the migration attempt above) — sealed from the
  // first byte it spends on disk.
  if (!existsSync(dataPath("gateway.config.json"))) {
    writeSecureJson(dataPath("gateway.config.json"), seedConfig());
  }

  // Guarantee the token exists, in the sealed env store (the plaintext .env replacement). A
  // generated token means clients configured against it keep working only if it is durable —
  // hence the data dir, not the npx cache. (The panel has no login: the loopback guard is its
  // boundary, so no password is generated.)
  const newToken = setEnvDefault("MCP_GATEWAY_TOKEN", randomBytes(24).toString("hex"))
    ? readEnvStore()["MCP_GATEWAY_TOKEN"]
    : undefined;

  chmodPrivate(dir, true);
  for (const f of ["env.json", "master.key", "managed.json", "tunnels.json", "gateway.config.json"]) {
    chmodPrivate(dataPath(f));
  }

  const report: FirstRunReport = { dataDir: dir, newToken, migrated, created };
  printReport(report);
  return report;
}

/** The panel URL from the config we just wrote or migrated — never a hardcoded 19999. */
function panelUrl(): string {
  try {
    const p = asListenPort((readSecureJson<{ port?: unknown }>(dataPath("gateway.config.json")) ?? {}).port);
    if (p !== undefined) return "http://127.0.0.1:" + p + "/";
  } catch {
    /* no config yet */
  }
  return "http://127.0.0.1:" + (envListenPort() ?? DEFAULT_PORT) + "/";
}
function printReport(r: FirstRunReport): void {
  if (!r.created && !r.migrated && !r.newToken) return; // ordinary boot: say nothing
  console.log("");
  console.log("mcp-gateway data dir: " + r.dataDir);
  if (r.migrated) {
    console.log("  (imported your existing .env / gateway.config.json from this directory — now encrypted at rest)");
  }
  if (r.newToken) console.log("  token:              lmg creds (the panel itself has no login)");
  console.log("  panel:              " + panelUrl());
  console.log("  skill:              " + SKILL_PATH);
  console.log("");
}
