# packages/hooks/

## Responsibility

`@cavemem/hooks` is the mode-aware front door for captured memory. It implements the five IDE lifecycle handlers (`session-start`, `user-prompt-submit`, `post-tool-use`, `stop`, `session-end`) and `src/runner.ts#runHook`, which either executes them against a local/injected `MemoryStore` or sends the raw input to a central worker. Local mode also owns the fire-and-forget worker handoff (`src/auto-spawn.ts#ensureWorkerRunning`); remote mode owns bounded HTTP delivery and local spool/replay. The package is `private: true` and is consumed by both `apps/cli` and the worker's server-side hook endpoint.

## Design

- **Hot-path budget (150 ms p95).** Individual handlers do no network I/O, summarization, or embedding — only synchronous `MemoryStore` work. The remote branch performs one timeout-bounded POST outside the handlers. `post-tool-use.ts` caps payload scanning at `MAX_SCAN_LEN` (8000 chars) and per-field serialization at 500 chars.
- **Mode-aware dispatcher.** `runHook(name, input, opts)` adds `metadata.host`, then follows one of three paths. An injected store is used directly without construction, close, or auto-spawn; local mode owns a store at `<dataDir>/data.db`; remote mode validates `remote.url` and delegates to `runRemote` without opening a local store.
- **Remote client** (`src/remote.ts`): `remoteTarget` accepts only an http(s) origin with no path/query/fragment. `postHook` performs one bearer-authenticated JSON POST to `/api/hooks/:event`, aborts at `remote.timeoutMs`, returns the server's `HookResult`, distinguishes HTTP 401 as `RemoteAuthError` and other 4xx as `RemotePermanentError`, and throws for remaining non-2xx responses.
- **Best-effort spool** (`src/spool.ts`): network, timeout, and non-401 HTTP failures attempt to append JSONL under `<dataDir>/spool.jsonl`; missing tokens, invalid targets, and 401 do not spool. The file is capped at 500 entries, successful HTTP delivery drains at most 10 oldest-first, transient failure keeps the remainder, malformed rows are logged and dropped, entries the worker permanently rejects (4xx) are logged and discarded rather than retried, and a lock file prevents overlapping append/drain rewrites (locks are never auto-reclaimed; a stale lock needs manual clearing).
- **No-throw/fail-open contract.** Handler exceptions become `HookResult { ok: false, error, ms }`. Remote target, token, auth, and delivery failures emit structured diagnostics and return `ok: true` with empty context so the IDE turn continues; the CLI then emits its normal hook telemetry.
- **Worker auto-spawn invariants** (`src/auto-spawn.ts`, documented in-source): <2 ms when the local worker is already running (one `existsSync` + liveness probe); detached and never awaited; skipped in remote mode, under `CAVEMEM_NO_AUTOSTART`, when `embedding.autoStart` is false, or when the provider is `none`; spawn failures do not fail the hook.
- **Debounce-by-skip.** `ensureWorkerRunning` is called after every hook except `session-end` — if the worker is alive (pidfile + liveness probe), the call is a cheap no-op; if not, one detached spawn happens and every concurrent hook call re-checks the pidfile.

## Flow

IDE event → shell stub (`hooks-scripts/`) → `cavemem hook run <name> --ide <ide>` (apps/cli) → `runHook`:

1. Add `metadata.host` when the caller did not supply one.
2. Injected/server path: dispatch against the caller-owned store, return the handler result, and neither close the store nor auto-spawn a worker.
3. Local path: load settings, open `MemoryStore`, dispatch synchronously, call `ensureWorkerRunning` after successful non-`session-end` hooks, return the result, and close the store. A missing local worker does not block writes; only semantic search degrades to BM25.
4. Remote path: validate the central-worker target and token, POST the raw input, and after success replay up to 10 spooled entries. On 401, log without spooling; on other delivery failures, attempt to spool and log; then return fail-open `ok: true` with no context. No local database or worker is opened.
5. `session-start` / `user-prompt-submit` may return context; other handlers return no stdout payload. `apps/cli` writes one normal structured telemetry line for every returned result in addition to any remote/spool diagnostic lines.

## Integration

- Depends only on `@cavemem/config` (settings, data-dir resolution, capture globs) and `@cavemem/core` (`MemoryStore`), preserving the package dependency order.
- `apps/cli` calls `runHook` from the installed hook commands; `apps/worker` calls it with an injected store from `POST /api/hooks/:event`. Per-IDE installers still invoke the same CLI hook command in both modes.
- Public surface is the single `package.json#exports` entry: `runHook`, `ensureWorkerRunning`, remote target/client/error APIs, spool APIs, the five handlers, and their hook/spool types.
- Tests: `test/runner.test.ts` covers local, injected, performance, and remote branches; `test/remote.test.ts` covers target validation, auth, non-2xx, and timeout; `test/spool.test.ts` covers cap/order/partial drain/locking/malformed rows; `test/post-tool-use.test.ts` covers capture filtering and bounded extraction.
