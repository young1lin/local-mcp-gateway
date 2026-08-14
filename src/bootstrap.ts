import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, dataPath } from "./datadir.js";
import { chmodPrivate, mkdirPrivate, writeFilePrivate } from "./privfs.js";
import { skillDir } from "./skilldir.js";
import { DEFAULT_PORT, asListenPort, envListenPort } from "./port.js";

/**
 * The minimal config seeded on first run: one `echo` MCP so the panel has a working endpoint
 * before any database is configured, and nothing else. The richer `gateway.config.example.json`
 * stays shipped for manual `cp` use (the README points at it); a zero-config first run wants no
 * row of "down" database templates the user never asked for. The skill carries the database
 * examples instead, where they are actually useful.
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
  /** The panel password, only when this run generated it. */
  newPass?: string;
  /** True when a repo-local .env / config was copied into the data dir. */
  migrated: boolean;
  /** True when the data dir did not exist before this call. */
  created: boolean;
}

/**
 * Append `key=value` to an env file iff the key is not already present (checked against both
 * `KEY=` and `export KEY=` forms). Preserves every existing line verbatim. Returns true when it
 * wrote a new value.
 */
function ensureEnvKey(envPath: string, key: string, value: string): boolean {
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const prefix = `${key}=`;
  const present = text
    .split(/\r?\n/)
    .some((l) => l.startsWith(prefix) || l.startsWith(`export ${prefix}`));
  if (present) return false;
  const sep = text && !text.endsWith("\n") ? "\n" : "";
  writeFilePrivate(envPath, text + sep + `${key}=${value}\n`);
  return true;
}

/** Copy a repo-local state file into the data dir, but only when the data dir does not already
 *  have one — so a first run of the new build from the repo picks up the user's existing setup,
 *  and later runs never clobber what the data dir owns. Returns true when it copied. */
function migrateOnce(repoFile: string, dataFile: string): boolean {
  const repoPath = join(process.cwd(), repoFile);
  if (!existsSync(repoPath) || existsSync(dataFile)) return false;
  copyFileSync(repoPath, dataFile);
  return true;
}

/**
 * Make the gateway runnable with no prior setup: create the data dir, pull in any repo-local
 * state once, seed a default config, and guarantee a token and panel password exist. Safe to call
 * every boot — it only acts on what is missing.
 *
 * Runs at the top of `main()`, before `loadConfig()`, because `loadConfig` reads the token from
 * the `.env` this writes.
 */
export function ensureFirstRun(): FirstRunReport {
  const dir = dataDir();
  const created = !existsSync(dir);
  mkdirPrivate(dir);

  // Pull an existing repo-local setup in once (the user's current .env / config), so an upgrade
  // does not throw away a working token and hand the operator a blank slate. Both are attempted —
  // `||` would short-circuit past the config copy once the .env copy succeeded, silently replacing
  // the user's real gateway.config.json with the echo-only seed.
  const envPath = dataPath(".env");
  const cfgPath = dataPath("gateway.config.json");
  const migratedEnv = migrateOnce(".env", envPath);
  const migratedCfg = migrateOnce("gateway.config.json", cfgPath);
  const migrated = migratedEnv || migratedCfg;

  // Seed a default config when none exists (after the migration attempt above).
  if (!existsSync(cfgPath)) {
    writeFilePrivate(cfgPath, JSON.stringify(seedConfig(), null, 2) + "\n");
  }

  // Guarantee credentials exist. A generated token means clients configured against it keep
  // working across machines only if it is durable — hence the data dir, not the npx cache.
  const newToken = ensureEnvKey(envPath, "MCP_GATEWAY_TOKEN", randomBytes(24).toString("hex"))
    ? readEnvValue(envPath, "MCP_GATEWAY_TOKEN")
    : undefined;
  // The panel defaults to admin/admin, which is insecure; generate a password when none is set,
  // leaving GATEWAY_USER at its "admin" default.
  const newPass = ensureEnvKey(envPath, "GATEWAY_PASS", randomBytes(12).toString("base64url"))
    ? readEnvValue(envPath, "GATEWAY_PASS")
    : undefined;

  chmodPrivate(dir, true);
  for (const f of [".env", "managed.json", "tunnels.json", "gateway.config.json"]) {
    chmodPrivate(dataPath(f));
  }

  const report: FirstRunReport = { dataDir: dir, newToken, newPass, migrated, created };
  printReport(report);
  return report;
}

/** Read a single KEY= value back out of an env file (the one this just wrote). */
function readEnvValue(envPath: string, key: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const prefix = `${key}=`;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return undefined;
}

/** The panel URL from the config we just wrote or migrated — never a hardcoded 19999. */
function panelUrl(): string {
  try {
    const p = asListenPort(JSON.parse(readFileSync(dataPath("gateway.config.json"), "utf8")).port);
    if (p !== undefined) return `http://127.0.0.1:${p}/`;
  } catch {
    /* no config yet */
  }
  return `http://127.0.0.1:${envListenPort() ?? DEFAULT_PORT}/`;
}
function printReport(r: FirstRunReport): void {
  if (!r.created && !r.migrated && !r.newToken && !r.newPass) return; // ordinary boot: say nothing
  console.log("");
  console.log(`mcp-gateway data dir: ${r.dataDir}`);
  if (r.migrated) console.log("  (imported your existing .env / gateway.config.json from this directory)");
  if (r.newToken || r.newPass) console.log("  login:              lmg creds");
  console.log(`  panel:              ${panelUrl()}`);
  console.log(`  skill:              ${SKILL_PATH}`);
  console.log("");
}
