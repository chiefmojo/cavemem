# packages/hooks/

## Responsibility

`@cavemem/hooks` is the write-path front door for captured memory: it implements the five IDE lifecycle hook handlers (`session-start`, `user-prompt-submit`, `post-tool-use`, `stop`, `session-end`), the dispatcher that runs them (`src/runner.ts#runHook`), and the fire-and-forget worker handoff (`src/auto-spawn.ts#ensureWorkerRunning`). Every observation and summary that enters cavemem during a coding session passes through `MemoryStore.addObservation` / `addSummary` here — synchronously, in-process, never across a network boundary. The package is `private: true` (not published); it is consumed only by `apps/cli`, whose `cavemem hook run <name>` command the per-IDE installers wire up.

## Design

- **Hot-path budget (150 ms p95).** Handlers do no network I/O, no summarization, no embedding — only synchronous SQLite writes via `MemoryStore`. Heavy work (embeddings, indexing) is delegated to the worker daemon. `post-tool-use.ts` additionally bounds its own work: payload scanning is capped at `MAX_SCAN_LEN` (8000 chars) and per-field serialization at 500 chars so a giant tool response cannot blow the budget.
- **Single dispatcher.** `runHook(name, input, opts)` in `src/runner.ts` switches on `HookName`, owns the `MemoryStore` lifecycle (constructs it from `loadSettings()` + `resolveDataDir(settings.dataDir)` + `data.db`, closes it in `finally`) unless the caller injects a store via `RunHookOptions.store` — the injection path exists so tests own the store lifecycle and skip both construction and `ensureWorkerRunning`.
- **No-throw contract.** Handler exceptions are caught in `runHook` and converted into `HookResult { ok: false, error, ms }` rather than propagating, so the CLI caller can log structured JSON and exit non-zero without a stack trace escaping.
- **Worker auto-spawn invariants** (`src/auto-spawn.ts`, documented in-source): <2 ms when the worker is already running (one `existsSync` on `worker.pid` + one `process.kill(pid, 0)` probe); never blocks the hook (`spawn` with `detached: true`, `stdio: 'ignore'`, `windowsHide: true`, `child.unref()`); skipped when `CAVEMEM_NO_AUTOSTART` is set, when `settings.embedding.autoStart` is false, or when `settings.embedding.provider === 'none'`; silent no-op when the CLI path (`process.argv[1]`) cannot be resolved. Spawn failures are swallowed — the hook still succeeds and the next hook retries.
- **Debounce-by-skip.** `ensureWorkerRunning` is called after every hook except `session-end` — if the worker is alive (pidfile + liveness probe), the call is a cheap no-op; if not, one detached spawn happens and every concurrent hook call re-checks the pidfile.

Remote delivery lives in `src/remote.ts`, which POSTs a hook to the configured worker with its bearer token and timeout, and `src/spool.ts`, which caps, persists, and drains failed non-auth deliveries. The runner's remote branch adds host metadata, delegates to `postHook` instead of opening a local store, and attempts a bounded spool drain after successful delivery.

## Flow

IDE event → shell stub (`hooks-scripts/`) → `cavemem hook run <name> --ide <ide>` (apps/cli) → `runHook`:

1. Load settings, open `MemoryStore` (unless injected).
2. Dispatch to the handler; the handler writes through `MemoryStore` and, for `session-start` / `user-prompt-submit`, returns a context string.
3. On success (non-`session-end`, non-injected), `ensureWorkerRunning(settings)` detaches the worker so embeddings/indexing happen in the background.
4. Return `HookResult { ok, ms, context? }` to the CLI, close the store.

If the worker is down or fails to spawn, writes still succeed — only semantic search degrades (BM25 keeps working).

## Integration

- Depends only on `@cavemem/config` (settings loading, `resolveDataDir`, `matchesGlob`) and `@cavemem/core` (`MemoryStore`) — consistent with the package order `config → compress → storage → {core, embedding} → hooks → installers`.
- Consumed by `apps/cli` (the `hook run` command), which is itself invoked by the shell stubs under `hooks-scripts/` that `packages/installers` register in each IDE's config.
- Public surface is the single export `.` in `package.json#exports`: `runHook`, `ensureWorkerRunning`, the five handlers, and the `HookName` / `HookInput` / `HookResult` types.
- Tests: `test/runner.test.ts` and `test/post-tool-use.test.ts` (vitest), using the injected-store path.
