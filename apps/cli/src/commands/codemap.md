# apps/cli/src/commands/

One module per `cavemem` subcommand (or small subcommand family). Each exports a `register*Command(program: Command)` function that attaches its command(s) to the root commander program; no module executes at import time.

## Responsibility

| Module | Commands | Job |
|---|---|---|
| `install.ts` | `install` | Wire an IDE (hooks + MCP) via `@cavemem/installers` |
| `uninstall.ts` | `uninstall` | Remove IDE wiring |
| `status.ts` | `status` | Wiring, DB counts, embedding backfill progress, worker liveness |
| `config.ts` | `config show/path/get/set/reset/open` | Settings viewing/editing |
| `doctor.ts` | `doctor` | Health checks (settings, DB, port, embedder, IDEs, Windows `sh`) |
| `lifecycle.ts` | `start` / `stop` / `restart` / `viewer` | Ergonomic daemon control (ollama/tailscale-style surface) |
| `worker.ts` | `worker start/run/stop/status` | Same pid management, plus foreground `worker run` |
| `mcp.ts` | `mcp` | Run the MCP stdio server (invoked by IDEs) |
| `search.ts` | `search` | Terminal memory query (BM25 + optional semantic re-rank) |
| `compress.ts` | `compress` / `expand` | File-level compression round-trip utilities |
| `export.ts` | `export` / `import` | JSONL dump and merge-import of memory |
| `hook.ts` | `hook run <name>` | Internal hook handler entrypoint invoked by `hooks-scripts/*.sh` |
| `reindex.ts` | `reindex` | Rebuild the FTS5 index |

## Design

- **Delegation, not logic**: every command loads settings through `@cavemem/config` (`loadSettings`, `resolveDataDir`, `settingsPath`), then calls into a package facade — `getInstaller()/installers` for IDE wiring, `MemoryStore` (`@cavemem/core`) for search, `Storage` (`@cavemem/storage`) for raw DB reads/counts, `runHook` (`@cavemem/hooks`) for hook execution, dynamic `import('@cavemem/worker').start()` and `import('@cavemem/mcp-server').main()` for the daemons (their own `isMainEntry()`/main guards prevent auto-start when bundled into the CLI, so `mcp.ts`/`worker.ts` must call them explicitly).
- **`hook.ts` is the IDE-protocol boundary**: validates names against `VALID` (`session-start`, `user-prompt-submit`, `post-tool-use`, `stop`, `session-end`), reads stdin JSON (`readStdin`, TTY → empty input, malformed → `{}`), translates Augment payload shapes via exported `normalizeForIde` (`conversation_id` → `session_id`, `workspace_roots[0]` → `cwd`, `conversation.agentTextResponse` → `turn_summary`) so `packages/hooks` stays IDE-agnostic. Telemetry JSON goes to **stderr**; **stdout** carries only the Claude-style `hookSpecificOutput: { hookEventName, additionalContext }` payload — and only for `session-start`/`user-prompt-submit` when `result.context` is non-empty. Failures set `process.exitCode = 1` (visible in the IDE hook log) without blocking the agent turn; unknown hook names also fail non-blocking (stale IDE configs must not wedge sessions).
- **Pidfile protocol shared by `lifecycle.ts` and `worker.ts`**: `dataDir/worker.pid` holds the worker pid; liveness via `process.kill(pid, 0)` (`isAlive`); stale pidfiles are unlinked. Both spawn the daemon as `process.execPath [resolveCliPath(), 'worker', 'run']` — explicitly `node <js>` because Windows cannot `spawn()` a `.js` file (npm's bin shim points at it; EFTYPE) — with `detached`, `stdio: 'ignore'`, and `windowsHide: true` (a popped console window would hang `cavemem start`). `lifecycle.ts` adds `waitForPidOrPort()` (5 s poll of the pidfile) and a browser opener (`open` / `cmd /c start` / `xdg-open`) for `viewer`.
- **Settings editing stays schema-validated** (`config.ts`): `getDotted`/`setDotted` navigate nested settings by dotted path, `coerce()` maps `true`/`false`/`null`/numbers/JSON literals, and `set` runs `SettingsSchema.safeParse` on the merged object before `saveSettings` — invalid values are rejected with exit 1. `config show` renders `settingsDocs()` (the zod schema `.describe()` strings) with `(default)`/`(set)` markers, so docs and schema can never drift.
- **`export.ts` merge semantics**: `exportJsonl` streams `{type:'session'|'observation', …}` lines from a readonly `Storage`. `importJsonl` shape-validates every line up front (`parseImportLine` — a bad line aborts before the DB is opened), then writes inside a single `Storage.transaction`; `--dry-run` throws the `DryRunComplete` sentinel to unwind/roll back the real write path (and uses `:memory:` if no DB exists yet, so a dry run never creates an empty `data.db`). Sessions merge by id (existing ids skipped; orphan observations get a synthesized parent session). Observation ids are per-machine AUTOINCREMENT, so `Storage.importObservation` treats the exported id as a *preference*: exact `(session_id, ts, content)` duplicates are skipped, a free id is used, an occupied id is reassigned — re-import is a no-op. Content is written verbatim, not recompressed: it already passed through `@cavemem/compress` on the exporting machine, and recompression under a different `compression.intensity` would break byte-identical round-trips.
- **Degradation with visibility** (`search.ts`): semantic re-rank is optional — skipped under `--no-semantic` or `provider === 'none'`, and an embedder failure downgrades to BM25 with a stderr warning rather than failing the query; slow embedder warm-up (>500 ms) is reported. `reindex.ts` swallows `rebuildFts()` errors (best-effort) but still reports `reindex ok`.
- **`status.ts` honesty annotations**: `annotateIde()` marks installers with `capture === 'none'` as `(query-only)` (#58 — MCP-only IDEs never capture observations), and worker state is read from `dataDir/worker.state.json` (backfill `embedded/total`, `lastBatchAt`, `lastError`) with pid liveness checked independently.
- **`install.ts` platform preflight**: `SH_DEPENDENT_IDES` = `{claude-code}` only (hooks run through Claude Code's `sh -c` wrapper on Windows, #56); `checkWindowsSh()` warns non-fatally for that set. Install writes default settings if missing, builds the installer context `{ ideConfigDir: homedir(), cliPath: resolveCliPath(), nodeBin: process.execPath, dataDir }`, marks `settings.ides[name] = true`, and prints provider-specific embedding guidance.

## Flow

- **Setup**: `install` → validate `--ide` against `installers` → ensure settings file → `installer.install(ctx)` returns per-step messages → persist `ides[name] = true` → Windows `sh` preflight → next-step hints. `uninstall` mirrors it (`installer.uninstall`, `delete settings.ides[name]`).
- **Hot path**: IDE stub → `hook run <name> --ide X` → stdin → `normalizeForIde` → `runHook` (`@cavemem/hooks`: compression + `MemoryStore.addObservation` + worker auto-spawn probe) → stderr telemetry → optional stdout `additionalContext` → exit code.
- **Query path**: `search <q>` → `MemoryStore.search(query, limit, embedder?)` → TSV rows `id \t score \t session_id \t snippet` (snippet whitespace collapsed).
- **Daemon path**: `start`/`worker start` → pidfile check → detached `node <cli> worker run` → pidfile write → (`lifecycle.ts` additionally waits and prints the viewer URL). `worker run` blocks in-process running `@cavemem/worker#start()`.
- **Data path**: `export <out>` → readonly `Storage` walk (`listSessions` + `timeline`) → JSONL. `import <file>` → full-file validation → one transaction → counts summary (`imported`/`dry-run: would import`).

## Integration

- Upward-facing: this is the module layer the IDEs, `hooks-scripts/*.sh` stubs, and humans invoke; `packages/hooks` defines the `HookName`/`HookResult` types and the actual handler logic, `packages/installers` owns IDE config mutation, `packages/config` owns every settings read/write (no command touches `settings.json` directly).
- Cross-references: `install`/`uninstall`/`lifecycle`/`worker` share `util/resolve.ts#resolveCliPath` for the path written into IDE configs and daemon spawns; `doctor` and `install` share `checkWindowsSh()`; `status` and `lifecycle` share the pidfile/state-file conventions in the data dir.
- Contract sensitivity: `hook.ts` stdout/stderr behavior is part of the publish-surface contract — changes require re-running `scripts/e2e-publish.sh` (CLAUDE.md gate).
