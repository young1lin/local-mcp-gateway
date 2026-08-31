# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, OpenCode, …) working in this
repo. This is the single source of truth for agent context — `CLAUDE.md` is a
symlink to this file.

## What this is

`local-mcp-gateway` is one local Node process that hosts every MCP server an AI
client needs, exposing each on an HTTP path under `127.0.0.1:19999`. It replaces
per-client, per-server process spawning with one shared, loopback-only gateway.
TypeScript (strict), MIT-licensed, Node >= 22.19.0 (undici 8 sets that floor).

## Load-bearing rules — do not break these

- **Loopback-only is security, not a default.** The gateway binds `127.0.0.1` and
  refuses any request whose `Host`/origin is not a loopback address
  (`src/local-only.ts`). Never weaken it or change the bind host to "reach it
  remotely" — forward the port over SSH instead.
- **Credentials are `${ENV_VAR}` references, never literals.** They expand only at
  adapter build time, so `gateway.config.json` and `managed.json` hold the
  reference, not the secret. The admin panel masks them back out
  (`src/mask.ts`). Keep it that way.
- **`http` / `rest` adapters have no health `ping` on purpose.** They are metered
  third-party endpoints; the registry deliberately reports them "unknown" rather
  than spending real requests every 15s. Don't add a ping.

## Commands

```bash
npm install          # deps
npm run build        # tsc -p tsconfig.build.json && copy the src/admin/ panel tree into dist
npx lmg start        # detached daemon (same as `lmg start` / `npm start`)
npm run dev          # tsx watch src/index.ts — hot reload while hacking
npm run typecheck    # tsc --noEmit — strict mode, must pass
npm test             # vitest run — full suite; DB tests self-skip without creds
```

`npm run typecheck` **and** `npm test` must both be green before a change is
considered done. No linter/formatter is wired up — follow the surrounding style
(2-space indent, double quotes, semicolons, trailing commas in multi-line).

## Layout

```
src/
  index.ts        entry — assembles registry + tunnels + HTTP server
  router.ts       HTTP routing
  registry.ts     the MCP registry every adapter plugs into
  local-only.ts   loopback enforcement (security-critical)
  mask.ts         credential masking for the admin panel
  adapters/       one module per MCP kind: mysql, pg, redis, mongo, proc, http, rest, echo
  tunnels/        SSH tunnel lifecycle (manager, forward, port, store)
  admin*.ts       the dashboard and its HTTP API
  cli.ts bin.ts   the `lmg` command
  daemon.ts       the detached background service; bootstrap.ts seeds first-run config
  skilldir.ts skill-install.ts  the shipped AI skill and `lmg skill install`
test/             vitest files, mirroring src/
.agents/skills/   the AI skill shipped in the npm package
```

## Making changes

- **A behavior change ships with a test** that fails before it and passes after.
  Put `test/<area>.test.ts` next to the module it covers.
- **A new adapter** → `src/adapters/<name>.ts`, register it with `registerAdapterFactory` in
  `factory.ts` (the same door third-party modules take from config via
  `"adapter": "<package or ./file.mjs>"`), add a field block to the panel's field-schema
  module (`src/admin/js/fields.js`), and a `test/<name>.test.ts`.
- **Form controls in the panel use the panel-wide styles, never per-view chrome.** The
  element-level rules (`select { appearance: none; … chevron … }`, `input:focus { … }`, the
  textarea/label styles) are the single source of control styling. A view may only add
  sizing/layout overrides (`width`, `min-width`, `padding-top/bottom`) on top — never override
  `background`, `border`, `appearance`, `box-shadow` or the focus ring of a `select`/`input`/
  `textarea`. Every dropdown must look like every other dropdown in the panel. The Data view's
  filter selects once shipped with their own borderless look and were reported as visually
  inconsistent — that's the bug class this rule exists to prevent. The native option POPUP is
  themed through `color-scheme` on `:root` (light/dark per theme) — never try to restyle
  `<option>` elements themselves; keep `color-scheme` in sync with the theme instead.
- **Don't reach for `any`** to make a type error go away — the project is strict
  on purpose.
- **Never commit** `gateway.config.json`, `.env`, `managed.json`, `tunnels.json`
  or `*.log` — all gitignored, all carry real secrets locally.

See `README.md` for full user-facing docs and `CONTRIBUTING.md` for the PR
process. Report security issues privately per `SECURITY.md`, never as a public
issue.
