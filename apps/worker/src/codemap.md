# apps/worker/src/

## Responsibility

The worker's four modules: `server.ts` (Hono app + process lifecycle), `embed-loop.ts` (background embedding backfill with observable state), `security.ts` (Host/Origin allowlist, bearer auth, and the viewer nonce/cookie handshake), and `viewer.ts` (server-rendered read-only HTML).

## Design

### server.ts

- `buildApp(store, opts: BuildAppOptions)` — pure app construction (exported for tests) taking `{ port, token, allowedHosts?, embedder?, loop? }`. Middleware order is the security design: `hostAllowlist(allowedHostSet(port, allowedHosts ?? []))` → `originCheck(same set)` → a no-op middleware that calls `loop?.touch()` on every request → an auth-router middleware: `/healthz` skips auth entirely, viewer paths (`/`, `/sessions/*`) get `viewerAuth(token, viewerSessions)`, everything else (`/api/*`, `/mcp`) gets `bearerAuth(token)`. Routes: `GET /healthz`, `POST /api/viewer-session`, `GET /api/state`, `GET /api/sessions`, `GET /api/sessions/:id/observations`, `GET /api/search`, `POST /api/hooks/:event`, `ALL /mcp`; HTML: `GET /`, `GET /sessions/:id` (404 via `c.notFound()` for unknown sessions).
- `POST /api/viewer-session` — bearer-protected like the rest of `/api/*`; returns `{ token: viewerSessions.mint() }`, the single-use nonce `cavemem viewer` puts in the handshake URL instead of the real token (keeps the long-lived credential out of a spawned browser opener's argv and out of browser history).
- `ALL /mcp` — stateless streamable HTTP: per request it builds `buildServer(store, store.settings, { embedder: opts.embedder ?? null })`, connects a fresh `WebStandardStreamableHTTPServerTransport({})` (the optional `sessionIdGenerator` is omitted — an explicit `undefined` trips `exactOptionalPropertyTypes` — which selects stateless mode), and returns `transport.handleRequest(c.req.raw)`. Tool registration is five calls, so the per-request cost is negligible; real MCP clients send no Origin, but the shared `originCheck` still applies so a browser page cannot reach the route.
- `POST /api/hooks/:event` — the remote-mode write path, guarded by `bodyLimit({ maxSize: 1_048_576 })`: an event not in the `HOOK_NAMES` set (`session-start`, `user-prompt-submit`, `post-tool-use`, `stop`, `session-end`) → 400, a non-JSON body → 400, a body without a string `session_id` → 400; otherwise `runHook(event, body, { store })` and the handler's `{ ok, error }` result as JSON (a failing handler is a failed result at HTTP 200). The client ships the raw IDE payload and the same handlers as local mode run against the worker's store, so redaction, exclusion, and compression stay in one place.
- Human-facing reads always expand: both HTML pages and the observations API map rows through `expand(r.content)` from `@cavemem/compress`; `/api/search` returns the store's compact hits untouched.
- `start()` — the executable path: pid file at `<dataDir>/worker.pid` (`writePidFile`/`removePidFile`), signal handlers (SIGTERM/SIGINT → `shutdown()`), embedder construction isolated from hooks, fallback minimal state file when `createEmbedder` fails or `provider: 'none'`, then `getOrCreateToken(settings)` and `serve({ fetch: app.fetch, port: settings.workerPort, hostname: settings.workerHost })` with `allowedHosts: settings.workerAllowedHosts` and the embedder handed to `buildApp` for `/mcp`; binding off `127.0.0.1` with an empty allowlist logs a warning that every non-loopback request will be rejected with 403.
- `isMainEntry()` — realpath-based entry guard so the tsup-bundled bin only auto-starts when run directly.

### embed-loop.ts

- `startEmbedLoop({ store, embedder, settings, onIdleExit?, idleTickMs? })` returns `EmbedLoopHandle { stop, touch, state }`.
- Startup purge: `store.storage.dropEmbeddingsWhereModelNot(embedder.model)` removes vectors from a previous provider/model in one shot (logged).
- `processOnce()` claims up to `settings.embedding.batchSize` rows via `observationsMissingEmbeddings(batchSize, model)`, embeds `expand(row.content)`, persists via `putEmbedding(row.id, model, vec)`; on embed failure it records `state.lastError`, logs, and breaks the batch (retried on the next tick rather than infinite per-row retry).
- Every batch ends with counter refresh (`countEmbeddings`/`countObservations`) and a snapshot write to `stateFilePath(settings)` = `<dataDir>/worker.state.json` (`writeFileSync`, best-effort — failures only mean stale status data).
- Idle logic: when a poll yields no work, the loop sleeps `idleTickMs` (default 2 s) and exits via `onIdleExit` once `idleShutdownMs` (clamped ≥ 0; `0` = never exit) has passed with **both** no embed work and no HTTP traffic (`state.lastHttpAt`, bumped by `touch()`).

### security.ts

- `getOrCreateToken(settings)` — token reuse across restarts; path from `workerTokenPath(settings.dataDir)` (`<dataDir>/worker-token`); generates 32 random bytes hex on first run and persists with `writeFileSync(..., { mode: 0o600 })` plus a best-effort `chmodSync(0o600)` because umask can widen creation-time perms.
- `allowedHostSet(port, extra)` — the Host/Origin trust boundary as a `Set<string>`: `127.0.0.1:<port>` and `localhost:<port>` are always accepted (on-box tooling keeps working), plus the `settings.workerAllowedHosts` `host:port` entries LAN clients use. Empty `extra` means loopback-only, even when `workerHost` is `0.0.0.0`.
- Four Hono `MiddlewareHandler` factories: `hostAllowlist(allowed)` (exact Host match against the set, else 403 — kills DNS rebinding), `originCheck(allowed)` (a present Origin must equal `http://<allowed host>`; absent Origin is allowed for native clients, mismatch → 403, and no CORS headers are ever added — kills browser-page CSRF), `bearerAuth(token)` (accepts `Authorization: Bearer <t>` or `x-cavemem-token`, `timingSafeEqual` after a length check → else 401), and `viewerAuth(token, sessions)` (HTML routes only — see below).
- `createViewerSessionStore()` — in-memory `Map<nonce, expiry>`; `mint()` returns a 24-byte hex nonce with a 2-minute TTL (`VIEWER_SESSION_TTL_MS`, expired entries pruned on mint); `consume(nonce)` deletes the entry regardless of outcome — single-use either way — and returns whether it was live. In-memory only: worth nothing once the worker restarts, and there's no reason to persist a one-shot. The nonce exists so the real bearer token never lands in a spawned opener's argv (`ps`/`/proc/<pid>/cmdline` — readable by any local user) or browser history.
- `viewerAuth(token, sessions)` — HTML routes can't carry an Authorization header on a top-level browser navigation, so a `?token=<nonce>` query is consumed via `sessions.consume` (invalid or already-spent → 401) and, on success, the real token is set as the `cavemem_viewer` cookie (`httpOnly`, `sameSite: 'Strict'`, `path: '/'`; no `secure` — the worker is plain HTTP by design; no `maxAge` — session-only, so the credential never touches browser disk) followed by a 302 redirect to the same path with the nonce stripped — it never sits in the URL bar or browser history past that first hop. Without a nonce, a timing-safe cookie match passes; otherwise the request falls through to `bearerAuth(token)`. Cookie auth is scoped to this middleware only — `/api/*` and `/mcp` stay on `bearerAuth`, so a viewer tab's cookie can never be replayed against the write path; `SameSite=Strict` plus the upstream `originCheck` close the usual CSRF hole a cookie would otherwise reopen.

### viewer.ts

- `renderIndex(sessions)` and `renderSession(session, observations)` — template-literal HTML with a shared `layout()` (inline dark stylesheet; no credential is embedded in served HTML — the cookie handshake replaced the old `__CAVEMEM_TOKEN__` injection). All dynamic strings pass through `esc()` (entity-escaping `&<>"'`); `SessionRow` comes from `@cavemem/storage`.

## Flow

- Browser/HTML request: → `hostAllowlist` → `originCheck` → `touch()` (keeps the worker alive) → `viewerAuth` (first visit: `?token=` nonce → cookie + 302; return visit: cookie match; a bearer token also works for non-browser clients) → `MemoryStore` read → expand → escaped HTML.
- API/MCP/hook request: → same Host/Origin checks → `touch()` → `bearerAuth` → handler (`/api/hooks/:event` runs the hook handler against the worker store; `/mcp` builds a stateless server + transport per request) → JSON.
- Backfill tick: `processOnce` → expand → embed → `putEmbedding` → snapshot → repeat until queue empty → idle countdown → `onIdleExit` → `start()`'s shutdown path (pid removal, `loop.stop()`, server close, `store.close()`, exit 0).

## Integration

- Imports strictly downward: `@cavemem/compress` (`expand`), `@cavemem/config` (`loadSettings`, `resolveDataDir`, `workerTokenPath`), `@cavemem/core` (`MemoryStore`), `@cavemem/embedding` (`createEmbedder`), `@cavemem/hooks` (`runHook`), `@cavemem/mcp-server` (`buildServer`), `@cavemem/storage` (row types); HTTP stack is `hono` (+ `hono/cookie`, `hono/body-limit`) + `@hono/node-server` + the MCP SDK's `WebStandardStreamableHTTPServerTransport`.
- Consumed by `packages/hooks` (detached spawn after writes; the spawn is skipped entirely in remote mode) and the CLI (status via `worker.state.json`, lifecycle via `worker.pid`). The token file is the single long-lived credential: remote clients send it as a bearer token, browsers trade a short-lived `/api/viewer-session` nonce for a `cavemem_viewer` cookie that only works on the HTML routes.
- Tests exercise `buildApp` and `startEmbedLoop` directly (`test/server.test.ts`, `test/embed-loop.test.ts`) without spawning the real process; `test/mcp-http.test.ts` drives `/mcp` over the SDK's `StreamableHTTPClientTransport`.
