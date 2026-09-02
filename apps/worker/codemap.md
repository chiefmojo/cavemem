# apps/worker/

## Responsibility

The local HTTP daemon (`@cavemem/worker`, bin `cavemem-worker`): a **read-only viewer plus embedding backfill loop** on `127.0.0.1:settings.workerPort`. It owns all background work hooks must not do (model loading, embedding) and serves a browser UI for browsing sessions/observations. It is never on the write path — if it is down, `MemoryStore.addObservation` from hooks still succeeds and only semantic search degrades.

## Design

- **Two responsibilities, one process** (`src/server.ts`): `start()` builds the embedder (unless `provider: 'none'`), starts the backfill loop, then serves the Hono app. Model load runs only here — hooks detach-spawn this process and never wait on it.
- **Loop as handle** (`src/embed-loop.ts`): `startEmbedLoop(...)` returns an `EmbedLoopHandle` (`stop`, `touch`, `state`); the HTTP layer calls `touch()` on every request so viewer activity counts as "still wanted" for idle shutdown. Loop state (`EmbedLoopState`: provider/model/dim/embedded/total/lastBatchAt/lastBatchMs/lastError/timestamps) is snapshotted to `<dataDir>/worker.state.json` after every batch so `cavemem status` reads it without HTTP.
- **Self-limiting lifetime**: the loop exits (`onIdleExit` → full shutdown) after `settings.embedding.idleShutdownMs` with neither embed work nor HTTP traffic; `0` disables the timer. This keeps the worker from lingering forever as a daemon.
- **Defense in depth** (`src/security.ts`): binding to 127.0.0.1 alone doesn't stop DNS rebinding, browser CSRF, or other local users. Three middleware layers: `hostAllowlist(port)` (Host header must be `127.0.0.1:<port>` or `localhost:<port>`), `originCheck(port)` (any present Origin must match, and no CORS headers are ever added), `bearerAuth(token)` scoped to `/api/*` only so plain HTML pages load with zero friction. Token: 32 random bytes hex, persisted at `<dataDir>/worker-token` with `mode: 0o600` **and** an explicit `chmodSync` (umask can widen creation-time mode).
- **Server-rendered viewer** (`src/viewer.ts`): `renderIndex`/`renderSession` build static dark-themed HTML with `esc()` HTML-escaping of all interpolated data; the bearer token is injected into served HTML (`window.__CAVEMEM_TOKEN__`) so future client-side JS can call `/api/*` — the token is never sent in JSON responses.
- **Ordered shutdown**: SIGTERM/SIGINT → remove `<dataDir>/worker.pid` → `loop.stop()` (awaits in-flight batch) → close HTTP servers → `store.close()`.

## Flow

1. `start()` → `loadSettings()` → `MemoryStore` on `<dataDir>/data.db` → write pid file.
2. `createEmbedder(settings)`; on failure, log `[cavemem worker] embedder unavailable` and still serve the viewer (BM25 search keeps working).
3. With an embedder: `startEmbedLoop` → one-time `dropEmbeddingsWhereModelNot(embedder.model)` purge on model switch → batch cycle: `observationsMissingEmbeddings(batchSize, model)` → for each row `expand(row.content)` (embeddings are computed on expanded text because models were trained on natural prose, not caveman grammar) → `embedder.embed` → `putEmbedding` → refresh counters + write state snapshot. Embed errors set `lastError`, are logged, and abort the current batch (retried next tick, visible in status).
4. Without an embedder: a minimal state file is still written so `cavemem status` has data.
5. HTTP: `GET /healthz`, `/api/state` (loop status), `/api/sessions`, `/api/sessions/:id/observations` (via `store.timeline`, content expanded), `/api/search?q=` (via `store.search`) behind bearer auth; `GET /` and `/sessions/:id` render the viewer via `viewer.ts`.

## Integration

- Depends on `@cavemem/core` (`MemoryStore` — all DB I/O), `@cavemem/config`, `@cavemem/embedding`, `@cavemem/compress` (`expand` for human-facing reads), `@cavemem/storage` (types), and `hono`/`@hono/node-server` for HTTP.
- Spawned detached by `packages/hooks` after a hook write (fire-and-forget; hooks never wait on it), and by the CLI (`cavemem status` reads `worker.state.json`; `worker.pid` supports lifecycle management).
- The viewer is the local counterpart of the separate Vite+React app in `viewer/`; this one is dependency-free server-rendered HTML.
- Tests: `test/embed-loop.test.ts` (batching, idle exit, state snapshot) and `test/server.test.ts` (routes, security middleware). Builds via tsup ESM to `dist/server.js` with the same `isMainEntry()` guard pattern as the MCP server.
