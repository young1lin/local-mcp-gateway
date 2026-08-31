# Security Policy

## Reporting a vulnerability

This gateway holds database credentials, API keys and SSH tunnels, so security
reports are welcome and taken seriously.

**Please do not open a public GitHub issue for a security problem.** Report it
privately, so a fix can ship before the details are public:

1. **Preferred** — GitHub's private vulnerability reporting: the *Report a
   vulnerability* button under the
   [Security](https://github.com/young1lin/local-mcp-gateway/security/advisories/new)
   tab.
2. **Fallback** — email the maintainer at `2550110827@qq.com` with
   `[security] local-mcp-gateway` in the subject.

Where you can, include: a description of the issue, steps to reproduce, the
versions affected, and the impact. You will get an acknowledgement within 72 hours.

## Scope

The gateway is **local-only by design** — it binds to `127.0.0.1` and refuses any
request whose `Host` or origin is not a loopback address. Reports about reaching the
gateway or its MCPs from another machine are out of scope *unless* they bypass that
check.

In scope:

- authentication / token bypass
- credentials leaking to the admin panel, the traffic log, or an error response
- injection in the SQL / Redis / Mongo adapters
- the SSH tunnel forwarding logic
- bypass of the loopback-only enforcement

## Supported versions

Only the latest release line receives security fixes.

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |
