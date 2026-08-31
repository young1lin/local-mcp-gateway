# local-mcp-gateway

One Node process that hosts every MCP server your AI clients need, on HTTP paths — replacing the
duplicated `npx` / `uvx` stdio spawns scattered across project `.mcp.json` files.

Each AI client (Claude Code, Codex, OpenCode, …) spawns its own copy of every MCP server over stdio,
duplicated per client and per project. On a busy machine that is easily a dozen-plus duplicate
processes and multiple gigabytes of RAM, with `npx` launchers orphaned when a client exits. This
gateway runs each MCP **once**, in-process where it can, and exposes it on a localhost HTTP path that
every client points at instead of spawning a child.

- Listens on `127.0.0.1:19999` — **this machine only, enforced, no opt-out** (see below).
- Management dashboard: `http://127.0.0.1:19999/` (health, config, tool browser, tool runner, call log).
- Tool endpoints: `POST /<name>` (bearer-token gated).

## Local only

This gateway holds live database credentials, SSH keys and third-party API keys, and hands whoever
reaches it tools that read and write production-adjacent data. There is no multi-user model and no
per-user authorization — a token names a client, not a person. So serving one machine is not a default
here, it is the boundary, and binding to loopback does not achieve it on its own:

| Layer | What it stops |
| --- | --- |
| `host` must be loopback, or the gateway refuses to start | `0.0.0.0` — which reads like "local" and means "every interface" |
| The peer address must be loopback | anything that reaches the port some other way |
| The `Host` header must name this machine | **DNS rebinding**: an attacker's domain resolves to `127.0.0.1`, so the connection really is local and every check above it passes |
| A present `Origin` must be loopback | a page on another site driving the API for its side effects |

A refusal is a `403` and is logged with its reason. There is deliberately no config flag to turn this
off: reaching the gateway from another machine is what SSH port forwarding is for.

## Supported adapters

| Type | How it runs | Notes |
| --- | --- | --- |
| `mysql` / `redis` / `pg` / `mongo` | **In-process** driver, imported on first use | No child process, so nothing can orphan and memory is tiny. Adding a DB = one config line. |
| `proc` | Spawns an **arbitrary** stdio command (`npx`, `uvx`, `python`, `docker …`) and proxies MCP over stdio | The escape hatch for any MCP without a direct adapter; tree-killed on close. **Lazy by default**: no child at boot — the first request spawns it, and an idle one is reaped after 10 min (`lazy: false` / `idleMs` to tune, `idleMs: 0` to keep it). `lazy: true` opts any other type into the same start-on-demand; the panel's *Start automatically at boot* checkbox is this switch. |
| `http` | Connects to a **remote** MCP endpoint over streamable HTTP and proxies it | `url` + `headers` (where the remote's API key goes — use a `${ENV_VAR}` reference). Nothing to spawn. Not health-probed: see below. |
| `rest` | Declares MCP tools over a **plain HTTP API** that does not speak MCP | The tools are authored in config: the vendor's own request example with `{{arg}}` in the slots. No adapter to write. |
| `echo` | Built-in no-op | Useful as a first endpoint with nothing else configured. |

### Tools

| Adapter | Tools |
| --- | --- |
| mysql | `mysql_query` |
| redis | `redis_scan`, `redis_read`, `redis_command` |
| pg | `pg_query`, `pg_list_tables`, `pg_describe_table` |
| mongo | `mongo_find`, `mongo_aggregate`, `mongo_list_collections`, `mongo_describe_collection` — plus `mongo_insert_many`, `mongo_update_many`, `mongo_delete_many` when the MCP is not read-only |
| proc / http / echo | whatever the child or remote exposes |

Deliberately small: a tool's schema is re-sent on every request, and one gateway hosts many MCPs, so
each tool set is the few things a model actually needs. A SQL `SELECT` with no `LIMIT` is capped
(200 rows by default) and says so in the reply; every result is bounded (1000 items / 256 KB) so one
query cannot flood a client's context.

`redis_read` is type-aware: one call answers "what is this key and what is in it?" — no `GET` on a
hash dead-ending with WRONGTYPE, no guessing which command fits. It returns
`{ key, type, ttl, length, truncated?, value }` with the value already shaped to the type (hash →
object, list → array, set → sorted array, zset → `{ member: score }` in rank order, stream →
`[{ id, fields }]`), and `offset`/`limit` page the ordered types. The same shapes over the raw
channel would be flat arrays, which is why `redis_command`'s description says so and points reads
back at `redis_read`.

### What `redis_command` refuses

One generic command tool needs a guard, and the guard runs before any socket is opened, so a refused
call costs nothing. Each rejection names what to use instead — an unexplained "no" just makes a model
try the next bad idea.

| Refused | Because |
| --- | --- |
| `KEYS` | walks the whole keyspace in one blocking pass — `redis_scan` reaches the same keys, cursor-based |
| `EVAL`, `EVALSHA`, `FCALL`, `SCRIPT`, `FUNCTION` | a script is opaque to every rule in this table, so one line of Lua reaches everything below. Per-MCP opt-in with `allowEval: true`; script *management* stays shut either way, since a runaway script has to be killed from `redis-cli` — this connection would already be blocked waiting for it |
| `MULTI`, `EXEC`, `WATCH`… | on a shared connection, one call's open transaction swallows every other call's commands and answers them `QUEUED` |
| `SUBSCRIBE`, `MONITOR`, `BLPOP`, `XREAD`, `SELECT`, `RESET`… | leaves the shared connection in a mode it never exits, or blocks it forever |
| `SHUTDOWN`, `DEBUG`, `REPLICAOF`, `MIGRATE`, `SWAPDB`, `SAVE`, `BGSAVE`, `MODULE`, `ACL`, `PSYNC`… | disrupts the server, rewrites its credentials, loads native code, or turns the connection into a replication stream |
| `CONFIG SET`, `CLIENT KILL`, `CLIENT PAUSE`, `CLUSTER RESET`… | the subcommand decides: `CONFIG GET`, `CLIENT LIST`, `CLUSTER INFO` and the other reads pass, and anything not on the allowlist is refused, so a future Redis release cannot add a subcommand that slips through |
| `FLUSHALL`, `FLUSHDB` | destructive but legitimate on a dev instance — per-MCP opt-in with `allowDestructive: true` |

The gateway's own guard is not a substitute for the server's. If the instance matters, give the
gateway a restricted Redis user as well, so the rules hold even if this code is wrong:

```
ACL SETUSER mcp on >a-password ~* +@read +@write -@dangerous -@scripting +info +config|get
```

Order matters — the denials come after the grants, so they win. This is a starting point, and it
denies a little more than the gateway does: `KEYS` and `FLUSHALL` are in `@dangerous`, but so are
`INFO` and `CONFIG`, which is why the last two rules add back the reads the panel and the tools use.
Add `+client|list`, `+cluster|info`, `+memory|usage` if you want the rest of the read subcommands.

### Read-only mode

Every DB adapter takes `readonly: true`. For the SQL adapters it sniffs the statement *and* sets a
server-side read-only session. For Mongo there is no session-level boundary, so the three write tools
drop out of `tools/list` entirely and aggregation pipelines containing `$out` / `$merge` are refused.

### Local stdio commands (`proc`)

`proc` is the escape hatch for any MCP without a direct adapter: one command string the gateway
spawns and speaks MCP to over stdio:

```json
"fetch": {
  "type": "proc",
  "description": "The reference fetch server, via uvx.",
  "command": "uvx mcp-server-fetch",
  "env": { "HTTP_PROXY": "${FETCH_PROXY}" }
}
```

`command` is tokenized with quote support — no shell — so `npx -y some-mcp`, `uvx mcp-…` and
`node "path with spaces\server.js"` all work. `env` adds variables to the child's environment
(`${ENV}` refs expand here like anywhere else). `cwd`, `exposeResources` and `exposePrompts` are
optional — `exposeResources: false` hides a child's thousands of table-schema resources, say. See
the adapter table above for the lazy-by-default lifecycle (`lazy`, `idleMs`).

### Remote MCPs (`http`)

A remote MCP is configured, not launched — where it is, and the headers its key travels in:

```json
"context7": {
  "type": "http",
  "description": "Context7 — up-to-date docs for any library.",
  "url": "https://mcp.context7.com/mcp",
  "headers": { "Authorization": "Bearer ${CONTEXT7_API_KEY}" }
}
```

Keep the key as a `${ENV_VAR}` reference: it then lives in `.env`, and neither the panel nor
`managed.json` ever holds it. A key typed straight into the panel is stored, but goes back out to the
browser masked, like a DB password.

A remote the machine cannot reach directly can name a proxy: `"proxy": "http://127.0.0.1:7890"`
(or a `${ENV}` ref) routes just this MCP's traffic through it — validated at start, not on the
first call.

Two deliberate differences from the other adapters:

- **No health probe.** The registry pings every started MCP every 15s; against a metered third-party
  endpoint that is thousands of requests a day nobody asked for. MCP makes `ping` optional, so this
  adapter answers "am I connected" without a round trip — reachability is proven once by the
  `initialize` handshake at startup, and a real failure surfaces on a real call, where the traffic log
  records it. The cost: the health dot reads "up" for a remote that went down since the last call.
- **Capabilities mirror the remote.** Resources and prompts are announced only if the remote actually
  negotiated them, so clients never spend a round trip asking for a list that cannot exist.

Streamable HTTP only. Some providers still publish an SSE endpoint beside it; those are legacy and
unsupported here.

### Declared HTTP APIs (`rest`)

Most HTTP APIs do not speak MCP at all, and the ones that do sometimes expose less than their REST
endpoint — parameters the vendor never wired through to the MCP tool. `rest` declares any REST endpoint
as a tool, in config, with no adapter written for it. Here it wraps GitHub's public REST API:

```json
"github": {
  "type": "rest",
  "baseUrl": "https://api.github.com",
  "headers": { "Accept": "application/vnd.github+json" },
  "tools": [{
    "name": "get_repo",
    "description": "Get a public GitHub repository.",
    "input": {
      "owner": { "type": "string", "required": true, "description": "User or organization." },
      "repo": { "type": "string", "required": true, "description": "Repository name." }
    },
    "request": {
      "method": "GET",
      "path": "/repos/{{owner}}/{{repo}}"
    },
    "pick": ["full_name", "description", "stargazers_count", "language", "license", "html_url"]
  }]
}
```

The design rule is that **the request you write is the request that gets sent** — the `request` block is
the vendor's own example with `{{arg}}` in the slots you want the model to fill. Everything else stays a
literal, so there is no separate notion of "fixed values" or "parameter mapping": a pinned
`"Accept": "application/vnd.github+json"` is just that string, sitting where the API expects it.

- `{{arg}}`, **not** `${arg}` — `${VAR}` already means "environment variable" everywhere in this config
  and is expanded before an adapter sees the definition. Two syntaxes that look alike and resolve from
  different places is a trap, so tool arguments get a visibly different one.
- A whole-string `"{{repo}}"` substitutes the argument value directly; text around it, like
  `"prefix-{{repo}}"`, interpolates as a string.
- A key whose argument was not supplied is **left out**, never sent as `null` — an omitted optional is
  how you get a confusing 400 out of an API that would have been happy with the field absent.
- `input` compiles to the JSON Schema clients see; `required` is enforced before any request is made, so
  a malformed call is never a billed one. `default` values are filled in and stated in the description.
- `path` may carry `{{arg}}` too, percent-encoded per segment. An unfilled path segment is an error
  rather than an empty one: `/repos//x` is a different endpoint.
- `pick` keeps named top-level response keys and drops the rest. Non-2xx answers become a tool error
  carrying the status and the body's first 600 bytes, so the API's own error code survives.
- Like `http`, there is no health probe — a declared REST API is just as metered.

### Third-party adapters

A type the gateway does not know can name the module that implements it, and be loaded at start —
no change to this package:

```json
"mine": {
  "type": "mine",
  "adapter": "some-lmg-adapter",
  "description": "Anything the module's createAdapter makes of this def."
}
```

`adapter` is a package name — installed beside the gateway, `npm i -g local-mcp-gateway
some-lmg-adapter` — or a path relative to the data dir (`"./my-adapter.mjs"`, next to
`gateway.config.json`). The module exports `createAdapter(def, name)`, named or default, returning
an object with a `type` and an async `build()` that returns an MCP `Server`; everything else
(`ping`, `close`, `makeServer`, `rename`, …) is optional and delegated, so a third-party type
behaves like a built-in — same lifecycle, call log and panel. `${ENV_VAR}` references in the def
are expanded before `createAdapter` sees it, so a credential stays a reference in
`managed.json` here too.

## Resources

Each DB adapter also exposes **resources** — schema you attach with an `@` mention, instead of
spending a tool call on it.

- **mysql** / **pg** — one resource per table plus a database overview, paginated 200 at a time. A
  table sharded into many physical copies is collapsed into one entry (so 1,000+ shard tables don't
  drown out the rest). Read `pg://<db>/<schema>.<table>` for its columns, primary key and indexes.
- **redis** — one resource per MCP: `redis://<name>/overview`, with the key count, a key-shape
  histogram and value types. Keys are not resources — use `redis_scan` for those.
- **mongo** — one resource per collection: `mongo://<db>/<collection>`, with the indexes, the
  `$jsonSchema` validator if any, and a field schema inferred from a 100-document sample (field,
  dominant type, prevalence). Mongo is schemaless, so the sample is a bounded best effort, never a
  scan.

Nothing is cached. A listing is one live catalog query, so a table added now is visible on the next
list. `resources.listChanged` is announced and the whole set can be toggled off from the Resources
tab — "off" empties the list (the capability stays, so the notify stays valid) and pushes
`notifications/resources/list_changed` to held-open clients.

Each tool can also be turned off individually from the Tools tab. A disabled tool drops out of
`tools/list` (it simply disappears — there is no other mechanism) and the gateway pushes
`notifications/tools/list_changed` so Claude Code re-lists without a reconnect. The toggle is live
and persists in `managed.json`.

Each MCP carries a `description` in the config, returned to clients as MCP `instructions` — the way
several otherwise-identical endpoints tell themselves apart.

## SSH tunnels

Every remote DB can be reached over an SSH tunnel this gateway owns itself, replacing a separate
port-forwarder (a typical standalone forwarder is ~160 MB for a few tunnels). The **Tunnels** view in
the panel has two tabs:

- **SSH Connections** — host, port, user, and `key` (path + optional passphrase) or `password` auth.
  Test dials a throwaway connection and reports latency and the server banner. Host keys are
  trust-on-first-use: the fingerprint is learned on first connect, and a change refuses the
  connection until you accept the new key.
- **Port Forwards** — `local port → target host:port` over a chosen connection, with optional
  auto-reconnect, and a `Serves MCPs` list that says which MCPs use the tunnel. Each MCP's detail page
  shows the same link from the other side, so a failing health check tells you whether the tunnel or
  the database is at fault.

The rule that matters: **a local port is bound only while its tunnel can carry traffic.** When the
transport dies (keepalive is 15 s × 3), the listener closes, every accepted socket is destroyed, and
the release is verified before the rule reports down — so you get an honest `ECONNREFUSED` instead of
a port that accepts connections and goes nowhere. Authentication and host-key failures are never
retried, so a reconnect loop cannot get you banned.

Connections and rules live in `tunnels.json` (gitignored; credentials are masked in the panel and
`${ENV}` refs work). `ssh2` is imported on the first tunnel start, never at boot.

## Dashboard

Sidebar of MCPs with live health; per-MCP tabs for tools, resources, prompts, **Run** (invoke any
tool, with the argument form generated from its own schema — every tool row also has a Try button),
**Config** (edit and restart; secrets are masked and `${ENV}` refs stay refs) and **Logs** (the
tool-call log — every call's arguments and replies, tagged by whether it came from a client or the
panel, persisted on disk across restarts and paged 20 at a time, plus child stderr for `proc`
MCPs).

Two panel conveniences are Windows-enhanced and degrade quietly elsewhere: the per-child memory
figure (measured by walking the process tree with PowerShell; on Linux the gateway's own footprint
still shows, the child breakdown does not) and port-conflict messages that name the process holding
the port.

## Setup

Requires Node >= 22.19.0 — the floor declared by `undici` 8, which backs the HTTP proxy support in the `http` and `rest` adapters.

```bash
npm install
cp gateway.config.example.json gateway.config.json   # then edit in your own MCPs
cp .env.example .env                                  # then fill in any DB credentials
npm test                                              # unit tests (DB integration tests auto-skip without creds)
npm run build
npx lmg start                                         # detached daemon — same as `lmg start`
```

`npm start` is the same command (`node dist/bin.js start`). For source hot-reload while hacking,
`npm run dev` (`tsx watch`) — that is a foreground process, not the daemon.

The first run generates the bearer token, writes it into `.env` in the data dir, and never prints
it into the daemon log. Read it back with `lmg creds` (url + token) — that is also what to ask an AI
agent to run, rather than pointing it at `.env`, which holds your database passwords too. The token
can also be viewed, copied and rotated from the panel's **Token** button; rotation persists to
`managed.json` and takes effect without a restart.

The panel itself has **no login**: the gateway answers loopback requests only, so reaching it at all
already means you are on the machine it serves. The bearer token remains the gate for MCP endpoints —
it is what AI clients authenticate with.

> **Do not put placeholder values in `.env`.** A generated credential is only filled in when the key
> is *absent* — a line that already reads `MCP_GATEWAY_TOKEN=` is taken at face value and becomes
> your real credential. That is why `.env.example` ships the key commented out.

The shipped example config includes an `echo` MCP that needs no database, so the panel has a working
endpoint immediately. The `mysql` / `redis` / `pg` / `mongo` entries are templates: they read their
credentials from `${ENV}` refs in `.env`, and any whose env var is empty simply reports `down` until
you fill it in — the rest stay up. You can also add or edit MCPs from the panel.

### Point a client at a gateway MCP

Each gateway MCP is one HTTP endpoint — `http://127.0.0.1:19999/<name>` — gated by your
`MCP_GATEWAY_TOKEN` as a bearer header. Add one entry per MCP you want to expose. The panel copies
each command below with the live token already embedded (an MCP's ⋮ menu → Copy Claude Code
command). Copies use the `default` token unless you click **Use** on another one in the Token sheet.

**Claude Code** — a one-line `claude mcp add`, and it runs in any shell (cmd, PowerShell, bash,
zsh, fish — nothing about it is shell-specific):

```bash
claude mcp add --transport http --scope user mysql http://127.0.0.1:19999/mysql \
  --header "Authorization: Bearer <your-token>"
```

`--scope user` makes it available in every project; `--scope project` writes it into the repo's
`.mcp.json`, and `--scope local` (the default) keeps it to you and this project. List with
`claude mcp list`, drop one with `claude mcp remove mysql`. Repeat per MCP — just change the name
and the `/<path>` (`redis`, `pg`, `mongo`, …).

**Codex** — edit `~/.codex/config.toml`. Codex has no direct one-line add for an HTTP server, so the
file is the source of truth. The remote-MCP shape has moved between versions; both of these appear
in current docs — use the one your version accepts:

```toml
[mcp_servers.mysql]
type = "http"
url = "http://127.0.0.1:19999/mysql"
headers = { "Authorization" = "Bearer <your-token>" }
```

…or, with the newer RMCP client enabled at the top of the file:

```toml
experimental_use_rmcp_client = true

[mcp_servers.mysql]
url = "http://127.0.0.1:19999/mysql"
bearer_token = "<your-token>"          # sent as Authorization: Bearer <your-token>
```

**OpenCode** — edit `opencode.json`:

```json
{
  "mcpServers": {
    "mysql": {
      "type": "remote",
      "url": "http://127.0.0.1:19999/mysql",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

Prefer to hand several clients one file? The raw `.mcp.json` block Claude Code writes under the
hood works anywhere it is read:

```jsonc
"mysql": { "url": "http://127.0.0.1:19999/mysql",
           "headers": { "Authorization": "Bearer <your-token>" } }
```

## Run

Installed globally, the gateway is a background service with a small command line:

```bash
npm i -g local-mcp-gateway

lmg start          # detach, then open the panel in a browser
lmg start -p 18000 # listen on 18000 and save it as the new default
lmg start --no-open
lmg status         # whether it is up, which MCPs it serves, what it costs in memory
lmg logs -f        # follow what the background process is printing
lmg stop           # ask it to shut down; force it only if it will not
lmg restart
lmg token          # the bearer token clients authenticate with
lmg creds          # panel url and the client token — for telling an AI
lmg open           # open the panel in a browser
lmg skill install  # copy the shipped AI skill where AI tools discover it
```

`lmg skill install` copies the package's skill (`.agents/skills/local-mcp-gateway/`) into
`~/.agents/skills/`, `~/.claude/skills/` and `~/.cursor/skills/` — user-level directories those
tools scan. The skill is opt-in (`disable-model-invocation`): it loads only when you invoke it.
After it, ask the agent for `lmg creds` rather than reading `.env`. Re-running after an upgrade
refreshes the copy.

The Add sheet can **Import .mcp.json** (Claude Code / Cursor / OpenCode). Stdio entries become
`proc` MCPs, remote URLs become `http` MCPs. A name that already exists lands as `redis-1`,
`redis-2`. Entries that already point at this gateway are skipped.

`lmg start` really does detach: the child gets its own hidden console, its stdio goes to a log file
instead of inheriting your terminal's handles, and the CLI unrefs it before exiting. Close the window
you started it from and it keeps serving. After a successful start (or if it was already running) the
CLI opens the panel in your browser. `--no-open` skips that. `lmg start -f` never opens a browser —
that is the form a Scheduled Task or systemd unit should invoke.

`--port` / `-p` on `start` is the listen port, and it is written into `gateway.config.json` so the
next `lmg start` uses it too. `MCP_GATEWAY_PORT` is the same override for the process itself.

Exit codes are scriptable — `0` done, `1` refused or failed, `3` nothing running — so a health check
does not have to parse text. `--port <n>` picks which instance to act on if you run more than one.
`lmg start -f` runs in the foreground instead, which is what a Scheduled Task or a systemd unit
should invoke, since those supply their own supervision.

State lives in `~/.mcp-gateway` (override with `MCP_GATEWAY_HOME`): the config, the token,
`gateway-<port>.pid` and `gateway-<port>.log`. From a clone, `npm run build && npx lmg start`
(or `npm start`) is the same detached service as a global `lmg start`. A fresh clone has no
`dist/` until it builds. `powershell -File scripts/start-gateway.ps1` builds on demand, then
runs that same `lmg start`. Crash-restart and start-at-logon belong to the OS, not the script.

### Stopping is graceful on purpose

`lmg stop` asks over HTTP (`POST /api/shutdown` — token-only, and unreachable from another machine
like every other route) rather than signalling. Windows has no deliverable `SIGTERM`: `process.kill`
there terminates unconditionally, which would skip the sequence that closes adapters and tree-kills
`proc`-MCP children — orphaning every child process, the exact leak this gateway already works hard
to avoid. The tree-kill is the floor, not the plan: it happens only when the graceful path does not
finish in time, and `stop` tells you which one it did.

If the recorded pid is alive but nothing answers on its port, `stop` **refuses** rather than killing
it — the OS may have recycled that pid into unrelated work. `--force` overrides that.

### Keeping it running across reboots

The package ships no supervisor. Crash-restart and start-at-logon belong to the OS, which does both
better than a wrapper process and costs no extra resident node. On Windows:

```powershell
$node   = (Get-Command node).Source
$entry  = "$env:APPDATA\npm\node_modules\local-mcp-gateway\dist\index.js"
$action = New-ScheduledTaskAction -Execute $node `
  -Argument "--max-semi-space-size=2 --max-old-space-size=256 `"$entry`""
Register-ScheduledTask -TaskName "MCP-Gateway" -Action $action `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force
```

Point the task at `dist/index.js`, not at `lmg start`: a task supervises the process it launches, and
`lmg start` exits as soon as it has detached, which the scheduler would read as a finished task. Turn
on restart-on-failure in the task's Settings tab if you want crash recovery. The two V8 flags are
worth ~15MB of RSS on this workload — `lmg start` applies them for you, a Scheduled Task has to be
told.

### npx

`npx local-mcp-gateway` is fine for a one-off look, but do not run a long-lived gateway that way.
npx's own wrapper stays resident for the whole life of the process (measured here at ~103MB of
`cmd.exe` plus npx's `node`, on top of the gateway), the cache it runs from is version-keyed and
cleared on update, and a Scheduled Task pointed at npx would hit the network on every logon.
`lmg start` warns when it detects it is running out of that cache.

## Config & secrets

`gateway.config.json` (gitignored — copy it from the example) holds your server layout with
`${ENV_VAR}` references; `.env` (also gitignored) holds the actual credentials.

`port` is optional and defaults to **19999**; `host` is optional and defaults to **127.0.0.1**. Change
the port with `lmg start --port 18000` (persisted) or by editing the file. Both are validated at load:
a malformed port or a non-loopback host stops the gateway with the reason, rather than quietly
listening somewhere nobody configured a client for.
 The gateway expands
the refs only at adapter build time, so anything persisted back through the panel keeps the reference
instead of being written to disk as plaintext. `managed.json` (user-added MCPs, gitignored) and
`tunnels.json` may hold secrets and are never committed.

## How it works

Each path owns one MCP `Server` built once at startup with its own DB connection; tool calls are
stateless, so all clients share one server per path safely. The direct adapters (mysql/redis/pg/mongo)
share the gateway's process and import their driver on first use; `proc` spawns a child and proxies
MCP over stdio.

## Releasing

CI (`.github/workflows/ci.yml`) runs typecheck, build and test on every push and pull request.

Releases publish to npm via **Trusted Publishing** — GitHub OIDC, no long-lived `NPM_TOKEN`. Pushing
a `v*` tag triggers `.github/workflows/publish.yml`, which verifies the tag matches `package.json`,
builds, tests, then `npm publish`.

The first release is manual (the package must exist before its Trusted Publisher can be configured on
npm); after that, every release is just:

```bash
npm version patch     # or minor / major
git push --follow-tags
```

## License

MIT — see [LICENSE](LICENSE).

