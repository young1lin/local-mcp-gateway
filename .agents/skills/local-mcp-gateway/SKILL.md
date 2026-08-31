---
name: local-mcp-gateway
description: local-mcp-gateway (lmg). Invoke only when the user explicitly asks.
disable-model-invocation: true
---

# local-mcp-gateway

One localhost Node process hosting MCP servers on `http://127.0.0.1:19999/<name>`.
State: `~/.mcp-gateway/` (`MCP_GATEWAY_HOME` to override).

Do not cat `.env` — it holds database passwords. For the client token, run `lmg token` (or `lmg creds`
for url + token). The panel itself has no login — loopback only.

## Gateway

```bash
lmg status          # up? url, every MCP, memory — or "not running"
lmg start           # detached background service, then opens the panel
lmg start -p 18000  # listen there; saved as the new default
lmg start --no-open
lmg logs            # -f to follow
lmg stop
lmg open            # panel in a browser
lmg token           # bearer token only (one line, for scripts)
lmg creds           # panel url + client token — tell the user these
lmg skill install   # copy this skill to ~/.agents, ~/.claude, ~/.cursor skills dirs
```

On Windows, `lmg status` first — the port refuses a duplicate. `lmg -p <port> <cmd>` for a non-default instance.

## Admin API

Base `http://127.0.0.1:19999`, loopback only (that is the whole gate). MCP endpoints still need
`Authorization: Bearer <token>` from `lmg token`; the `/api` routes need no header.

| Action | Method + path | Body |
| --- | --- | --- |
| List MCPs | `GET /api/mcps` | — |
| Query one | `GET /api/mcps/<name>/details` | — |
| **Add** | `POST /api/mcps` | `{ "name", "type", …fields }` |
| **Import `.mcp.json`** | `POST /api/mcps/import` | the file's JSON (`mcpServers` / `servers` / bare map) |
| **Modify** | `PUT /api/mcps/<name>` | `{ "type", …fields }` |
| Remove | `DELETE /api/mcps/<name>` | — |
| Restart | `POST /api/mcps/<name>/restart` | — |

Import turns stdio `command`+`args` into `proc`, remote `url` into `http`. Names already in use become `redis-1`, `redis-2`. Entries whose URL is this gateway are skipped.

Secrets: put the credential in `~/.mcp-gateway/.env`, reference `${REDIS_PASS}` in the MCP.

**Redis** `type: redis` — `description, host, port, password, db, readonly, allowDestructive, allowEval`

**MySQL** `type: mysql` — `description, host, port, user, password, database, timezone, readonly, maxRows`

**Postgres** `type: pg` — `description, url, readonly, maxRows` (`url` required)

**Mongo** `type: mongo` — `description, url, database, readonly, maxRows`. Drop `readonly` for write tools.

Add returns `201` `{ name, type, lifecycle }`. Unset `${ENV}` → `down`; fill it and restart.

## Connect a client

**Claude Code**

```bash
claude mcp add --transport http --scope user redis http://127.0.0.1:19999/redis \
  --header "Authorization: Bearer <token>"
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.redis]
type = "http"
url = "http://127.0.0.1:19999/redis"
headers = { "Authorization" = "Bearer <token>" }
```

A new MCP is usable after the client reconnects. `readonly: true` unless the user needs writes. Loopback only — SSH-forward the port to reach it from another machine.
