# packages/hooks/src/

## Responsibility

The package's entire implementation: the public export surface (`index.ts`), the hook dispatcher (`runner.ts`), the worker-daemon handoff (`auto-spawn.ts`), and the shared hook I/O contracts (`types.ts`). Handler implementations live one level down in `handlers/`.

## Design

- **`index.ts`** is a flat re-export barrel — nothing but `export` statements, no logic. Consumers get exactly: `runHook`, `ensureWorkerRunning`, the five handlers, and the three types.
- **`runner.ts`** centralizes everything handlers should not care about: settings loading, store construction/teardown, timing (`performance.now()` → rounded `ms`), the post-hook `ensureWorkerRunning` call, and error capture. `RunHookOptions.store` inverts store ownership for tests: when injected, the runner neither constructs nor closes the store and skips the spawn entirely.
- **`auto-spawn.ts`** keeps the probe path allocation-free and branch-light: `CAVEMEM_NO_AUTOSTART` → `embedding.autoStart` → `provider !== 'none'` → pidfile stat → `isAlive(pid)` via `process.kill(pid, 0)` → `resolveCli()` from `process.argv[1]`. Only the miss path pays the `spawn` cost, and it is `detached` + `unref` + `stdio: 'ignore'` + `windowsHide: true` (Windows can't exec a raw `.js` path directly, hence `process.execPath <cli>`; `windowsHide` prevents a console window flashing from the detached child).
- **`types.ts`** defines `HookInput` as a *union of fields* rather than a strict schema: Claude Code's payload names (`tool_name`, `tool_response`, `last_assistant_message`, `transcript_path`, `permission_mode`, `source`, `reason`, `prompt`) coexist with legacy aliases (`tool`, `tool_output`, `turn_summary`) so non-Claude-Code IDEs and tests drive the same handlers without payload translation. `ide` is not sent by Claude Code itself — the installer wires `--ide claude-code` into the hook command and the CLI injects it before handlers run. `HookResult` carries `ok` / `ms` / optional `context` (injected prompt text) / optional `error`.

## Flow

- `runHook(name, input)` → switch over the five `HookName` values → `sessionStart` / `userPromptSubmit` (return `context`), `postToolUse` / `stop` / `sessionEnd` (return void) → `ensureWorkerRunning` (unless `session-end` or injected store) → `HookResult`.
- Timing is measured around the whole switch, so `HookResult.ms` reflects the full handler duration — the number the 150 ms p95 budget is judged against.
- `finally` closes the store only when the runner owns it.

## Integration

- `runner.ts` imports all five handlers from `./handlers/`; handlers never import `runner.ts` (no cycles).
- Types in `types.ts` are the lingua franca between `apps/cli` (which parses argv + stdin into `HookInput`), `packages/installers` (whose generated hook commands must match what the CLI expects), and the tests.
- Depends on `@cavemem/config` (`loadSettings`, `resolveDataDir`) and `@cavemem/core` (`MemoryStore`).
