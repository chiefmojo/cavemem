# Remote mode

## What remote mode is

Remote mode lets one central cavemem worker on a trusted LAN own the SQLite store for every coding agent and machine. A client enters remote mode when `settings.remote.url` is set: hook handlers run against the server's `MemoryStore`, and supported MCP clients query the same store over stateless streamable HTTP at `<remote.url>/mcp`. The server itself remains in local mode and runs with a LAN bind, an explicit Host/Origin allowlist, and idle shutdown disabled.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `remote.url` | unset | Base URL of the central worker, for example `http://neuromancer:37777`; its presence enables remote mode on a client. |
| `remote.token` | unset | Bearer token copied from the server's `worker-token` file. |
| `remote.timeoutMs` | `1500` | Abort deadline in milliseconds for a client hook POST. |
| `workerHost` | `"127.0.0.1"` | Worker bind interface. A shared server uses `"0.0.0.0"`. |
| `workerAllowedHosts` | `[]` | Additional accepted `host:port` Host headers and matching `http://<host:port>` Origins. Empty keeps the loopback-only fallback even if `workerHost` is `"0.0.0.0"`. |
| `embedding.idleShutdownMs` | `600000` | Idle lifetime in milliseconds; `0` disables shutdown and is required for the central server. |

The central server should set `workerHost` to `"0.0.0.0"`, provide a non-empty `workerAllowedHosts`, and set `embedding.idleShutdownMs` to `0`. Client settings need only the `remote` block; retain the local database as a fallback until the server has been validated.

## What changes on a client

- Hooks still invoke `cavemem hook run <event>` locally, but the runner adds `metadata.host` and synchronously POSTs the raw hook input to `<remote.url>/api/hooks/:event`. Non-auth delivery failures are spooled locally for best-effort replay.
- After setting `remote.url`, run or rerun `cavemem install` for each client IDE. It writes remote MCP entries for Claude Code (`type: "http"`), Codex (`url` plus `bearer_token_env_var: "CAVEMEM_REMOTE_TOKEN"`), and OpenCode (`type: "remote"`) instead of stdio commands.
- `cavemem search` calls `GET <remote.url>/api/search` with the bearer token instead of querying a local store.
- Local-only commands refuse with `remote mode: run this on the server`: `worker *`, `start`, `stop`, `restart`, `viewer`, `reindex`, `export`, `import`, and `mcp`.

## Failure behaviour

| Condition | Outcome |
|-----------|---------|
| Server unreachable or timeout | Spool when possible; emit a structured remote-failure JSON line plus the CLI's normal hook telemetry line to stderr (a spool error may add its own structured line); exit 0 with empty context. A session started during an outage gets no prior-session injection at all; that is accepted degradation, not a regression. |
| 401 | Emit a remote failure line with `reason: "auth"` plus normal hook telemetry, no spool (replay would fail identically), exit 0. |
| `remote.url` set, token missing | No POST. Emit a remote failure line with `reason: "no-token"` plus normal hook telemetry, exit 0. `doctor` reports it. |
| Spool replay fails mid-drain | Stop, keep remainder, retry on next successful hook. |
| Worker restart | systemd `Restart=on-failure`. Clients spool during the gap and drain after. |
| Unknown `:event` on `/api/hooks` | 400 with a JSON error body. |
| Hook handler throws server-side | `runHook` already returns `{ ok: false, error }`; returned as 200 with that body so the client logs it rather than spooling a poison payload. |

SQLite contention does not arise: one process owns the store and is the only writer.

## Privacy

Privacy is enforced at the write boundary. Content inside `<private>…</private>` tags is stripped. Paths matching `settings.excludePatterns` are never read. Neither appears in logs. The write boundary is the server's `MemoryStore`: in remote mode, raw hook payloads cross the LAN to the central worker before `excludePatterns` and `<private>` stripping apply (spec decision 4, 2026-09-02).

Remote mode assumes a trusted subnet and uses a static bearer token; it does not add TLS, OAuth, or per-client tokens. The worker requires auth on every route except `/healthz`. `/api/*` and `/mcp` accept only the bearer token (`Authorization: Bearer <token>` or `X-Cavemem-Token`) — a browser navigation can't set either header. The viewer HTML routes (`/`, `/sessions/:id`) instead accept a one-time `?token=` query parameter, which the server trades for an `HttpOnly`, `SameSite=Strict` session cookie and a redirect that strips the token from the URL; `cavemem viewer` performs this handshake automatically. The cookie authenticates HTML routes only — it is never accepted on `/api/*` or `/mcp`, so a viewer tab open in a browser can't be used to drive the write path.

## Deployment

Follow the [shared memory server deployment runbook](../deploy/README.md) to install the central worker, migrate the canonical store, configure clients, and verify cross-machine search.
