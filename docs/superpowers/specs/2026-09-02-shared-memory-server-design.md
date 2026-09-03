# Shared Memory Server — Design

**Date:** 2026-09-02
**Tracks:** OpenProject WP #194
**Supersedes in part:** `~/companion-ops/specs/2026-09-02-cavemem-shared-memory-server.md` (Faye's spec). Goal, non-goals, and requirements carry over unchanged; the change list below replaces that spec's table where the two disagree.

## Goal

One cavemem worker on the LAN owns the SQLite store. Every coding agent on every machine (Claude Code, Codex, OpenCode) writes observations to it through hooks and reads from it through MCP, so hand-offs between agents and machines carry shared context without manual re-paste.

## Non-goals

- Not a reasoning engine. Structured facts plus full-text and vector retrieval only.
- Companions (Faye/Dora/Violet) are not consumers of this work.
- No Tailscale, no TLS, no OAuth. Single trusted subnet, static bearer token.
- oh-my-pi (`omp`) integration. No cavemem hooks or MCP entry exist for it today; that is a separate IDE-integration item.
- Durable delivery. Queue-and-replay is best-effort; dropped observations are acceptable.

## Decisions taken (2026-09-02, Erick)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Host | **neuromancer**. Remote-first from the dev box (wintermute) surfaces network, retry, and auth flaws on the primary consumer immediately. |
| 2 | Service account | **`agentops`**, login-capable, separate from `faye`. Will host more than cavemem over time. |
| 2b | Legacy store `/home/faye/.cavemem` (66M) | **Shelve.** Tarball into the agentops home, do not import. Wintermute's live store is canonical. |
| 3 | MCP listener | **Mounted inside the worker** at `/mcp` on the existing port (`37777`). No second listener. |
| 4 | Privacy filtering | **Server-side only.** Raw hook payloads cross the LAN; `excludePatterns`, `<private>` stripping, and secret redaction run in the server's `MemoryStore` as today. CLAUDE.md rule 6 amended. |

## Findings that reshaped Faye's spec

1. **Binding `0.0.0.0` alone breaks every request.** `apps/worker/src/security.ts` hardcodes the Host allowlist and Origin check to `127.0.0.1:<port>` / `localhost:<port>`. LAN requests get 403 before the bearer token is read. Needs a configurable allowlist.
2. **SSE is the wrong transport.** Codex CLI 0.152 (`codex mcp add --url`) supports streamable HTTP only. SDK 1.29 deprecates `SSEServerTransport` and ships `WebStandardStreamableHTTPServerTransport`, which is fetch-API native and drops into Hono directly. Claude Code (`--transport http`) and OpenCode (`type: remote`) both speak it.
3. **Hooks read, not just write.** `session-start` reads recent sessions and summaries to inject prior context; `session-end` reads turn summaries to roll up. A write-only `POST /api/observations` cannot serve them. Handlers therefore run server-side, one endpoint per hook event.
4. **The worker self-exits.** `embedding.idleShutdownMs` defaults to 600 000; a central server must set `0`. Clients must also stop detach-spawning a local worker.
5. **Per-session process duplication.** Today every stdio MCP client spawns its own `cavemem mcp` process with its own SQLite handle and, after the first search, its own copy of the embedding model. Mounting MCP in the worker removes all of it.

## Architecture

### Modes

One binary, two modes, selected by the presence of `remote.url` in settings.

- **Local mode** (default, no `remote.url`): identical to today. Hooks write to the local DB, `cavemem mcp` serves stdio, worker auto-spawns for embedding.
- **Remote mode** (`remote.url` set): hooks POST to the server; installers write URL-based MCP entries; `cavemem search` calls `/api/search`; auto-spawn is disabled. Local-only commands (`worker`, `reindex`, `export`, `import`, `viewer`) exit non-zero with `remote mode: run this on the server`.
- **Server**: a local-mode install with `workerHost: "0.0.0.0"`, a non-empty `workerAllowedHosts`, and `idleShutdownMs: 0`.

### Settings (`packages/config`)

```
remote: {
  url?: string          // e.g. http://neuromancer:37777 — presence enables remote mode
  token?: string        // copy of the server's worker-token
  timeoutMs: number     // default 1500; hook POST abort deadline
}
workerHost: string           // default '127.0.0.1'
workerAllowedHosts: string[] // default []; Host/Origin allowlist when bound off loopback
```

`workerAllowedHosts` entries are `host:port` strings. When the list is empty the allowlist falls back to today's loopback pair, so a stray `0.0.0.0` bind with no allowlist still rejects every non-loopback request rather than opening up. Origin check accepts `http://<entry>` for each entry.

All fields get `.describe()` strings so `cavemem config show` documents them automatically.

### Server (`apps/worker`)

- `POST /api/hooks/:event` — bearer-protected. Body is `HookInput` JSON. Validates `:event` against `HookName`, calls `runHook(name, input, { store })` with the worker's store, returns `HookResult`. Injected store already means no auto-spawn and no close inside `runHook`; handlers run unmodified.
- `ALL /mcp` — bearer-protected. Stateless `WebStandardStreamableHTTPServerTransport` (`sessionIdGenerator: undefined`). A fresh `buildServer()` and transport per request, as the SDK requires for stateless mode. Tool registration is five calls; cost is negligible.
- `buildServer(store, settings, deps)` in `apps/mcp-server` gains `deps.embedder?: Embedder | null`. When supplied, the lazy loader is bypassed and the worker's already-loaded model is used. `apps/worker` adds a workspace dependency on `@cavemem/mcp-server` and imports `buildServer` from it; `apps/cli` already depends on both apps, so this app-to-app edge follows existing practice and keeps `packages/*` free of app imports. `apps/mcp-server` remains the stdio entrypoint for local mode; nothing is removed.
- Security middleware reads `workerAllowedHosts`; bearer middleware unchanged.
- `worker run` stays the foreground entrypoint used by systemd.

### Client (`packages/hooks`)

- `remote.ts`: `postHook(settings, name, input)` — one `fetch` POST with `AbortController` at `remote.timeoutMs`, `Authorization: Bearer` header. Returns the server's `HookResult`.
- `runner.ts`: when `settings.remote.url` is set and no store is injected, delegate to `postHook` instead of opening a local store. Before sending, set `input.metadata.host = os.hostname()`.
- `session-start.ts`: persist `metadata.host` on the session row (today `metadata` is always `null`).
- `auto-spawn.ts`: return early when `remote.url` is set.
- Spool (`spool.ts`): on POST failure other than 401, append `{ name, input, ts }` as one JSON line to `<dataDir>/spool.jsonl`. After any successful hook, replay up to 10 entries oldest-first, then stop. File is capped at 500 lines; when exceeded the oldest lines are dropped. Replayed rows receive server insert time, not original time. A partial drain stops at the first failure and leaves the remainder.

### Installers (`packages/installers`)

Each installer checks `settings.remote.url` at install time and writes the remote MCP shape instead of the stdio one:

| IDE | Remote entry |
|-----|--------------|
| Claude Code | `mcpServers.cavemem = { type: "http", url: "<url>/mcp", headers: { Authorization: "Bearer <token>" } }` |
| Codex | `mcp_servers.cavemem = { url: "<url>/mcp", bearer_token_env_var: "CAVEMEM_REMOTE_TOKEN" }`. Codex reads the variable from its own environment, so the installer prints an instruction to export it in the shell profile and `cavemem doctor` checks that it is set. |
| OpenCode | `mcp.cavemem = { type: "remote", url: "<url>/mcp", headers: { Authorization: "Bearer <token>" } }` |

Hook commands are unchanged in all three: they still run `cavemem hook run <event>` locally; the CLI performs the POST. `uninstall` and `status` handle both shapes.

### CLI (`apps/cli`)

- `search`: in remote mode, call `GET /api/search` with the bearer header.
- `status`: in remote mode, report `remote.url`, reachability of `/healthz`, and spool depth.
- `doctor`: in remote mode, verify token present, `/healthz` reachable, `/api/state` authorised; warn if a local worker pidfile exists.
- `worker`, `reindex`, `export`, `import`, `viewer`: refuse in remote mode with a one-line message and exit 1.

### CLAUDE.md amendments

- Rule 6: add "The privacy boundary is the server's write path. In remote mode, raw hook payloads cross the LAN to the worker before `excludePatterns` and `<private>` stripping apply."
- Rule 9: add "In remote mode, hooks POST synchronously to the central worker over HTTP and spool locally on failure. Local mode is unchanged: no daemon on the write path."
- Layout table: note `/mcp` in `apps/worker` and `apps/mcp-server` as a stdio wrapper.

## Data flow

**Write, remote mode.** IDE fires hook → `cavemem hook run <event>` → CLI loads local settings, sees `remote.url` → POST `/api/hooks/<event>` with payload plus `metadata.host` → server `runHook` with its store → redact, compress, insert → `HookResult` → CLI prints context (session-start only), exits 0. Target: under 30 ms end-to-end on the LAN.

**Read.** MCP client → `POST /mcp` with bearer → worker builds a stateless server for the request → `search` / `timeline` / `get_observations` / `list_sessions` against the shared store, semantic rerank via the worker's embedder → response. `enrich` stays opt-in via `settings.enrich.enabled` on the server.

## Error handling

| Condition | Outcome |
|-----------|---------|
| Server unreachable or timeout | Spool, one structured JSON log line to stderr, exit 0, empty context. |
| 401 | Log line with `reason: "auth"`, no spool (replay would fail identically), exit 0. |
| `remote.url` set, token missing | No POST. Log line, exit 0. `doctor` reports it. |
| Spool replay fails mid-drain | Stop, keep remainder, retry on next successful hook. |
| Worker restart | systemd `Restart=on-failure`. Clients spool during the gap and drain after. |
| Unknown `:event` on `/api/hooks` | 400 with a JSON error body. |
| Hook handler throws server-side | `runHook` already returns `{ ok: false, error }`; returned as 200 with that body so the client logs it rather than spooling a poison payload. |

SQLite contention does not arise: one process, one writer.

## Deployment

### Server (neuromancer)

1. Create `agentops` with a login shell and home directory. Install Node ≥ 20 for that user.
2. Build the fork, `pnpm --filter cavemem pack` (or the tarball `scripts/e2e-publish.sh` already produces), copy to neuromancer, `npm i -g ./cavemem-<version>.tgz` as `agentops`. The npm registry package is upstream's frozen release and does not contain this work.
3. On wintermute: `cavemem stop`, then `sqlite3 ~/.cavemem/data.db 'PRAGMA wal_checkpoint(TRUNCATE)'`, then `rsync -a ~/.cavemem/ agentops@neuromancer:~/.cavemem/`. Remove `worker.pid` and `worker-token` from the copy; the server mints a fresh token on first start.
4. Edit `~agentops/.cavemem/settings.json`: `workerHost: "0.0.0.0"`, `workerAllowedHosts: ["neuromancer:37777", "<lan-ip>:37777"]`, `embedding.idleShutdownMs: 0`.
5. Shelve legacy: `tar czf ~agentops/legacy-faye-cavemem-2026-09-02.tgz -C /home/faye .cavemem`.
6. Install `deploy/cavemem-worker.service` (system unit: `User=agentops`, `ExecStart=<prefix>/bin/cavemem worker run`, `Restart=on-failure`, `WantedBy=multi-user.target`). Enable and start.
7. Read the token from `~agentops/.cavemem/worker-token` for client distribution.

### Client cutover (wintermute, then any other box)

1. `cavemem stop` and confirm no `worker run` process remains.
2. Set `remote.url` and `remote.token` in `~/.cavemem/settings.json`.
3. `cavemem install claude-code codex opencode` to rewrite MCP entries.
4. Export `CAVEMEM_REMOTE_TOKEN` in the shell profile for Codex.
5. `cavemem doctor` must be green. Local `data.db` stays untouched as a fallback until deliberately deleted.

## Testing

- **Unit** (`packages/config`, `apps/worker`, `packages/hooks`, `packages/installers`): allowlist derivation from settings including the empty-list fallback; `/api/hooks/:event` through `buildApp` with a temp store for every event plus unknown event and missing bearer; `postHook` with mocked fetch covering success, timeout, 401, and non-401 failure; spool append, cap at 500, drain of 10, partial-drain stop; installer output for the three remote shapes and round-trip through uninstall.
- **Integration**: MCP inspector against `/mcp` on a temp worker — `initialize`, all four core tools, `enrich` absent when disabled, 401 without bearer. Required by CLAUDE.md for MCP contract changes.
- **End-to-end**: a remote-mode leg in `scripts/e2e-publish.sh`. Start one packed install as server on a random port with `workerHost: 127.0.0.1` and an allowlist entry for it; drive a second isolated `$HOME` in remote mode through every Claude Code hook event; assert rows land in the server DB, the client DB does not exist, and `cavemem search` from the client returns a hit. Existing 15 checks stay green.
- **Live**: wintermute against neuromancer. One full Claude Code session, then `cavemem search` from wintermute for a phrase said during it, then the same via the MCP `search` tool from Codex.

## Out of scope, noted for later

- `get_observations` hardcodes `expand: true`, ignoring `compression.expandForModel`. Unchanged here.
- Ordering of replayed spool entries relative to live writes. Accepted per the requirements.
- oh-my-pi hooks and MCP entry.
- TLS or per-client tokens. Single subnet, single token, by decision.
