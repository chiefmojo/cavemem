# apps/worker/src/

## Responsibility

The worker's four modules: `server.ts` (Hono app + process lifecycle), `embed-loop.ts` (background embedding backfill with observable state), `security.ts` (loopback hardening middleware + bearer token), and `viewer.ts` (server-rendered read-only HTML).

## Design

### server.ts

- `buildApp(store, opts: BuildAppOptions)` — pure app construction (exported for tests) taking `{ port, token, loop? }`. Middleware order is the security design: `hostAllowlist(port)` → `originCheck(port)` → a no-op middleware that calls `loop?.touch()` on every request → `bearerAuth(token)` mounted on `/api/*` only. Routes: `GET /healthz`, `GET /api/state`, `GET /api/sessions`, `GET /api/sessions/:id/observations`, `GET /api/search`; HTML: `GET /`, `GET /sessions/:id` (404 via `c.notFound()` for unknown sessions).
- Human-facing reads always expand: both HTML pages and the observations API map rows through `expand(r.content)` from `@cavemem/compress`; `/api/search` returns the store's compact hits untouched.
- `start()` — the executable path: pid file at `<dataDir>/worker.pid` (`writePidFile`/`removePidFile`), signal handlers (SIGTERM/SIGINT → `shutdown()`), embedder construction isolated from hooks, fallback minimal state file when `createEmbedder` fails or `provider: 'none'`, then `serve({ fetch: app.fetch, port: settings.workerPort, hostname: '127.0.0.1' })`.
- `isMainEntry()` — realpath-based entry guard so the tsup-bundled bin only auto-starts when run directly.

### embed-loop.ts

- `startEmbedLoop({ store, embedder, settings, onIdleExit?, idleTickMs? })` returns `EmbedLoopHandle { stop, touch, state }`.
- Startup purge: `store.storage.dropEmbeddingsWhereModelNot(embedder.model)` removes vectors from a previous provider/model in one shot (logged).
- `processOnce()` claims up to `settings.embedding.batchSize` rows via `observationsMissingEmbeddings(batchSize, model)`, embeds `expand(row.content)`, persists via `putEmbedding(row.id, model, vec)`; on embed failure it records `state.lastError`, logs, and breaks the batch (retried on the next tick rather than infinite per-row retry).
- Every batch ends with counter refresh (`countEmbeddings`/`countObservations`) and a snapshot write to `stateFilePath(settings)` = `<dataDir>/worker.state.json` (`writeFileSync`, best-effort — failures only mean stale status data).
- Idle logic: when a poll yields no work, the loop sleeps `idleTickMs` (default 2 s) and exits via `onIdleExit` once `idleShutdownMs` (clamped ≥ 0; `0` = never exit) has passed with **both** no embed work and no HTTP traffic (`state.lastHttpAt`, bumped by `touch()`).

### security.ts

- `getOrCreateToken(settings)` — token reuse across restarts; generates 32 random bytes hex on first run and persists at `<dataDir>/worker-token` with `writeFileSync(..., { mode: 0o600 })` plus a best-effort `chmodSync(0o600)` because umask can widen creation-time perms.
- Three Hono `MiddlewareHandler` factories: `hostAllowlist(port)` (exact `127.0.0.1:<port>`/`localhost:<port>` Host — kills DNS rebinding), `originCheck(port)` (mismatched Origin → 403; absent Origin allowed, and no CORS headers are ever added — kills browser-page CSRF), `bearerAuth(token)` (accepts `Authorization: Bearer <t>` or `x-cavemem-token` → else 401).

### viewer.ts

- `renderIndex(sessions, token)` and `renderSession(session, observations, token)` — template-literal HTML with a shared `layout()` (inline dark stylesheet, `window.__CAVEMEM_TOKEN__` injection). All dynamic strings pass through `esc()` (entity-escaping `&<>"'`); `SessionRow` comes from `@cavemem/storage`.

## Flow

- Viewer request: browser → `hostAllowlist` → `originCheck` → `touch()` (keeps the worker alive) → HTML page (no auth) or `/api/*` (bearer auth) → `MemoryStore` read → expand → escaped HTML/JSON.
- Backfill tick: `processOnce` → expand → embed → `putEmbedding` → snapshot → repeat until queue empty → idle countdown → `onIdleExit` → `start()`'s shutdown path (pid removal, `loop.stop()`, server close, `store.close()`, exit 0).

## Integration

- Imports strictly downward: `@cavemem/compress` (`expand`), `@cavemem/config` (`loadSettings`, `resolveDataDir`), `@cavemem/core` (`MemoryStore`), `@cavemem/embedding` (`createEmbedder`), `@cavemem/storage` (row types); HTTP stack is `hono` + `@hono/node-server` with zero other runtime deps.
- Consumed by `packages/hooks` (detached spawn after writes) and the CLI (status via `worker.state.json`, lifecycle via `worker.pid`); the token file coordinates with the viewer's injected `__CAVEMEM_TOKEN__` for API calls from served pages.
- Tests exercise `buildApp` and `startEmbedLoop` directly (`test/server.test.ts`, `test/embed-loop.test.ts`) without spawning the real process.
