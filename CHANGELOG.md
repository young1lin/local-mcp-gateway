# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-18

Initial public release.

### Added

- A single local Node process that hosts every MCP server an AI client needs,
  exposed on `127.0.0.1:19999` HTTP paths — replacing per-client, per-server
  spawning with one shared gateway.
- In-process database adapters — MySQL, Postgres, Redis, MongoDB — with `readonly`
  mode (server-side read-only sessions for SQL, dropped write tools for Mongo) and
  declared schema resources.
- `proc` (stdio child process), `http` (remote MCP over streamable HTTP) and `rest`
  (turn any REST endpoint into an MCP tool from config alone) adapters.
- SSH tunnel manager for databases reachable only through a bastion host.
- Management dashboard — health, config, tool browser, tool runner and call log — at
  `http://127.0.0.1:19999/`. Sidebar entries carry a per-launch-method colour tag (http,
  npx, uvx, echo, …), and the toolbar's appearance control is a one-click sun/moon toggle
  (auto governs until the first explicit click).
- `lmg` CLI to start / stop / restart / status / logs / token / creds / open as a managed
  daemon, plus `lmg skill install` — copies the shipped AI skill into `~/.agents/skills/`,
  `~/.claude/skills/` and `~/.cursor/skills/` so AI tools discover it. The skill is opt-in
  (`disable-model-invocation: true`).
- `lmg creds` prints the panel URL, user, password and token, so an AI can be told the login
  without reading `.env` (which also holds database passwords).
- First run generates a random token and a random panel password, and prints neither into the
  daemon log — `lmg creds` is how you read them.
- `lmg start` opens the panel in a browser; `--no-open` skips it, and `lmg start -f`
  (foreground, for a Scheduled Task / systemd unit) never opens one.
- `lmg start --port N` listens on N and writes it into `gateway.config.json` as the new
  default. `MCP_GATEWAY_PORT` is the same override for the process.
- `POST /api/mcps/import` and an **Import .mcp.json** button: bring Claude Code / Cursor /
  OpenCode client configs onto the gateway. Colliding names become `redis-1`, `redis-2`.
  URLs that already point at this gateway are skipped.
- `POST /api/mcps/test` + a **Test connection** button on the DB, `http` and `rest` forms: a real
  check with the form's current values (`${ENV}` refs expanded server-side) — a driver connect for
  the databases, the initialize handshake for a remote MCP, one plain request to the baseUrl for a
  declared API (any HTTP answer = reachable) — reporting the underlying error verbatim, asked
  before saving anything.
- Third-party adapter modules: any config entry with `"adapter": "<package or ./file.mjs>"`
  loads an external `createAdapter(def, name)` at start, with the built-ins registered through
  the same `registerAdapterFactory` door.
- Lazy MCPs: a `proc` is lazy by default (no child at boot — the first request spawns it, the
  request waiting; an idle child is reaped after 10 minutes), and `lazy: true` opts any other
  type into the same start-on-demand. `lazy: false` restores start-at-boot; `idleMs` tunes the
  reaper (`0` disables). Idle shows as `idle` in the panel, and every Add/Edit form carries a
  *Start automatically at boot* checkbox that writes this switch.
- Copied connect commands embed the `default` token unless you click **Use** on another one in
  the Token sheet; a missing choice never opens a `prompt()` (which fails in the Cursor IDE
  browser).
- Proc MCPs find `uvx` / `npx` even when `lmg start` inherited a PATH without `~/.local/bin`
  (the usual uv install location on Windows). Their stderr on Windows decodes GBK (cmd.exe's
  CP936) when the bytes are not UTF-8, so a missing `uvx` reports the real OS message instead
  of mojibake.
- `GET /health` is liveness only (`{ ok: true }`). MCP names and health stay behind `/api/mcps`.
- Loopback-only enforcement, token authentication, and `${ENV_VAR}` credential
  references that never persist a secret in config or `managed.json`.

[Unreleased]: https://github.com/young1lin/local-mcp-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/young1lin/local-mcp-gateway/releases/tag/v0.1.0
