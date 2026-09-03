# apps/worker/

## Responsibility

The HTTP daemon (`@cavemem/worker`, bin `cavemem-worker`) owns the viewer and embedding backfill loop and can also act as the shared-memory server. It binds to `settings.workerHost:settings.workerPort` (`127.0.0.1:37777` by default). In local mode it remains off the write path; when remote clients are configured, it is their central write path through `POST /api/hooks/:event` and their model-facing read path through stateless streamable HTTP MCP at `/mcp`.

## Design

- **Four responsibilities, one process** (`src/server.ts`): `start()` owns one `MemoryStore`, builds the embedder (unless `provider: 'none'`), starts the backfill loop, and serves the viewer, read APIs, remote hook endpoint, and HTTP MCP route. Model load runs only here — local-mode hooks may detach-spawn this process and never wait on it.
- **Loop as handle** (`src/embed-loop.ts`): `startEmbedLoop(...)` returns an `EmbedLoopHandle` (`stop`, `touch`, `state`); the HTTP layer calls `touch()` on every request so viewer activity counts as "still wanted" for idle shutdown. Loop state (`EmbedLoopState`: provider/model/dim/embedded/total/lastBatchAt/lastBatchMs/lastError/timestamps) is snapshotted to `<dataDir>/worker.state.json` after every batch so `cavemem status` reads it without HTTP.
- **Self-limiting lifetime**: the loop exits (`onIdleExit` → full shutdown) after `settings.embedding.idleShutdownMs` with neither embed work nor HTTP traffic; `0` disables the timer and is required for a persistent central server.
- **Remote hook execution**: `POST /api/hooks/:event` validates the event and JSON body, then calls `runHook(event, input, { store })`. The injected store keeps the handler in-process and leaves lifecycle ownership with the worker; redaction, exclusion, and compression therefore remain at the server's `MemoryStore` boundary.
- **HTTP MCP**: `ALL /mcp` creates a fresh `buildServer()` and `WebStandardStreamableHTTPServerTransport` per request in stateless mode, reusing the worker's loaded embedder when available.
- **Defense in depth** (`src/security.ts`): `allowedHostSet(port, workerAllowedHosts)` always includes loopback and adds explicit LAN `host:port` values. `hostAllowlist` and `originCheck` cover every route; absent Origin is allowed for native clients, browser Origins must match, and no CORS headers are added. `bearerAuth` covers `/api/*` and `/mcp`, while HTML routes do not require authentication. The 32-byte random token is persisted at `<dataDir>/worker-token` with `mode: 0o600` and an explicit `chmodSync`.
- **Server-rendered viewer** (`src/viewer.ts`): `renderIndex`/`renderSession` build static dark-themed HTML with `esc()` HTML-escaping of all interpolated data; the bearer token is injected into served HTML (`window.__CAVEMEM_TOKEN__`) so future client-side JS can call `/api/*` — the token is never sent in JSON responses.
- **Ordered shutdown**: SIGTERM/SIGINT → remove `<dataDir>/worker.pid` → `loop.stop()` (awaits in-flight batch) → close HTTP servers → `store.close()`.

## Flow

1. `start()` → `loadSettings()` → `MemoryStore` on `<dataDir>/data.db` → write pid file → bind Hono to `settings.workerHost:settings.workerPort`; an off-loopback bind with an empty `workerAllowedHosts` logs a warning and still rejects non-loopback Host headers.
2. `createEmbedder(settings)`; on failure, log `[cavemem worker] embedder unavailable` and still serve the viewer (BM25 search keeps working).
3. With an embedder: `startEmbedLoop` → one-time `dropEmbeddingsWhereModelNot(embedder.model)` purge on model switch → batch cycle: `observationsMissingEmbeddings(batchSize, model)` → for each row `expand(row.content)` (embeddings are computed on expanded text because models were trained on natural prose, not caveman grammar) → `embedder.embed` → `putEmbedding` → refresh counters + write state snapshot. Embed errors set `lastError`, are logged, and abort the current batch (retried next tick, visible in status).
4. Without an embedder: a minimal state file is still written so `cavemem status` has data.
5. HTTP reads: `GET /healthz`; bearer-protected `/api/state`, `/api/sessions`, `/api/sessions/:id/observations` (content expanded), and `/api/search?q=`; public `GET /` and `/sessions/:id` render the viewer.
6. Remote writes and MCP: bearer-protected `POST /api/hooks/:event` dispatches against the worker-owned store; bearer-protected `ALL /mcp` delegates tool registration to `@cavemem/mcp-server`. Both remain behind the global Host/Origin checks.

## Integration

- Depends on `@cavemem/core` (`MemoryStore` — all DB I/O), `@cavemem/config`, `@cavemem/embedding`, `@cavemem/compress` (expanded human-facing reads), `@cavemem/storage` (types), `@cavemem/hooks` (server-side hook dispatch), `@cavemem/mcp-server` (shared tool registration), the MCP SDK transport, and `hono`/`@hono/node-server`.
- Local-mode hooks may spawn it detached after writes; remote-mode clients never spawn a local worker. The CLI manages local lifecycle and status, while a central server runs `worker run` in the foreground (normally under systemd).
- The viewer is the dependency-free server-rendered implementation in `src/viewer.ts`; there is no separate `viewer/` application in this repository.
- Tests: `test/embed-loop.test.ts` covers batching, idle exit, and state snapshots; `test/server.test.ts` covers viewer/read routes, Host/Origin/bearer security, allowlisted LAN hosts, and all remote hook cases; `test/mcp-http.test.ts` drives `/mcp` with the SDK's `StreamableHTTPClientTransport`, including tools, auth rejection, and browser-Origin rejection. Builds via tsup ESM to `dist/server.js` with the same `isMainEntry()` guard pattern as the MCP server.
