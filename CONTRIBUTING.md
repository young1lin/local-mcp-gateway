# Contributing

Thanks for considering a contribution to `local-mcp-gateway`. This is a small,
focused project — the bar is "correct and tested", not "clever".

## Setup

Requires Node.js 22.19.0 or newer (the floor `undici` 8 declares).

```bash
git clone https://github.com/young1lin/local-mcp-gateway.git
cd local-mcp-gateway
npm install
```

Copy the example config if you want to exercise the gateway locally. The everyday start
path is the same CLI users run:

```bash
cp gateway.config.example.json gateway.config.json
cp .env.example .env
npm run build
npx lmg start        # detached daemon — same as `lmg start` / `npm start`
```

`npm run dev` (`tsx watch src/index.ts`) is only for hacking with auto-reload; it is a
foreground process, not the daemon.

The dashboard is then at `http://127.0.0.1:19999/` (login `admin` / `admin` — see
`.env`).

## Before you open a PR

Both of these must pass locally:

```bash
npm run typecheck    # tsc --noEmit — strict mode, no type errors
npm test             # vitest run — the full suite
```

A PR that fails typecheck or tests will not be merged. Database-dependent tests
self-skip when no `PG_URL` / `MYSQL_PASS` / etc. is set, so you do **not** need a
running database to run the suite.

## What a good change looks like

- **Add a test.** A behaviour change comes with a test that fails before the change
  and passes after it. The `test/` directory mirrors `src/` — put a `.test.ts` next
  to the module it covers.
- **Keep the strict types.** The project compiles under `strict: true`; do not reach
  for `any` to make a type error go away.
- **Match the existing style.** No formatter is wired up yet; follow what is already
  in the file you are editing (2-space indent, double quotes, semicolons, trailing
  commas in multi-line).
- **One concern per PR.** It keeps review fast and the history readable.

## Project layout

```
src/
  index.ts          entry — assembles the registry, tunnels and HTTP server
  router.ts         HTTP routing
  registry.ts       the MCP registry every adapter plugs into
  adapters/         one module per MCP kind: mysql, pg, redis, mongo, proc, http, rest, echo
  tunnels/          SSH tunnel lifecycle (manager, forward, port, store)
  admin*.ts         the dashboard and its API
  cli.ts bin.ts     the `lmg` command
test/               vitest files, mirroring src/
```

## Issues vs. security

Bug reports and feature ideas go in
[GitHub Issues](https://github.com/young1lin/local-mcp-gateway/issues). Security
vulnerabilities follow [SECURITY.md](./SECURITY.md) — do **not** use a public issue
for those.

By contributing, you agree that your contributions are licensed under the project's
[MIT license](./LICENSE).
