# apps/cli/src/

CLI entrypoint, the OpenCode plugin bridge, and build-time type declarations.

## Responsibility

- `index.ts` — the `cavemem` bin entrypoint: builds the commander program, guards against double-execution, handles top-level process concerns (EPIPE, unhandled command errors, version banner).
- `opencode-bridge.ts` — OpenCode plugin module (`dist/opencodeBridge.js`, separate tsup entry) that bridges OpenCode's event stream into cavemem hook commands and injects prior-session context into the system prompt.
- `env.d.ts` — ambient declaration for the `__CAVEMEM_VERSION__` constant tsup injects via `define` (value = `package.json` version).

## Design

- **`createProgram()` is exported and side-effect-free**; actual startup lives under `if (isMainEntry())`. `isMainEntry()` compares `import.meta.url` against `pathToFileURL(realpathSync(process.argv[1]))` — the `realpathSync` step is what makes the check survive npm's bin shim, where `argv[1]` is a symlink pointing at the real `dist/index.js`. Falls back to the unresolved path if realpath fails.
- **EPIPE tolerance**: a `process.stdout.on('error')` handler exits 0 on EPIPE so `cavemem … | head` / `| grep -q` doesn't print a misleading uncaught-exception stack for an upstream-terminated pipe.
- **Error contract**: `parseAsync().catch()` writes `cavemem error: <message>` to stderr and exits 1 (rule 8: no silent failures).
- **Mode-agnostic entrypoint**: `index.ts` itself contains no remote-mode logic (`settings.remote.url` set ⇒ the machine talks to a central server). Commands self-select after loading settings: remote-aware ones branch on `util/remote.ts#checkedRemoteTarget()`, local-only ones bail via `util/mode.ts#requireLocal()` (see `commands/codemap.md`). One consequence of the error contract: remote HTTP failures are *not* caught per-command, so they surface as `cavemem error: remote search failed: …` + exit 1 from here.
- **Bridge dependency minimization**: `opencode-bridge.ts` declares minimal local types (`BunShell`, `PluginInput`, `OpenCodeEvent`, `Hooks`) instead of depending on `@opencode-ai/plugin` — the bridge is loaded dynamically by OpenCode, so a runtime dependency would be dead weight in the bundle.
- **Bridge write/read split**: all *writes* go through the CLI (`spawn(CAVEMEM, ['hook', 'run', name, '--ide', 'opencode'])`, detached + unref'd, JSON on stdin) so they pass the compression/redaction pipeline enforced by `MemoryStore`; the single *read* path (`getRecentContext`) opens a read-only `MemoryStore` directly to prime new sessions. This keeps hooks fast (never awaited by the IDE) while reuse of `runHook` stays canonical.
- **Binary discovery**: `resolveCavememCli()` tries three strategies — sibling `index.js` next to the bridge file (same `dist/`), `which cavemem`, `npm root -g` + `cavemem/dist/index.js` — then falls back to bare `'cavemem'` on PATH.

## Flow

**index.ts**: `cavemem <args>` → `isMainEntry()` → EPIPE handler installed → `createProgram()` registers all 13 command modules → `parseAsync(process.argv)` → action handlers run; any rejection becomes stderr + exit 1.

**opencode-bridge.ts**: OpenCode calls `cavememBridge({ directory })` once per session and receives a `Hooks` object:

- `event` dispatch: `session.created` → `runHook('session-start')`; `command.executed` → `post-tool-use` with `tool_name: "cmd:<name>"`; `message.part.updated` accumulates assistant text deltas into `messageTexts` keyed by message ID; `message.updated` routes by role — user messages flush as `user-prompt-submit`, completed assistant messages flush via `flushTurn` as a `stop` hook carrying `turn_summary`; `session.idle`/`session.deleted` flush pending turns, then fire `session-end`. Every hook spawn is detached/unref'd (the IDE never waits on a `cavemem hook run` round-trip).
- `tool.execute.after` → `post-tool-use` with args truncated to 500 chars and output to 2000.
- `experimental.chat.system.transform` → pushes a one-line notice about the memory tools, then (once per session, tracked by `queriedSessions`) `getRecentContext()` lists up to 50 sessions, filters to ended sessions with `s.cwd === directory` (project scoping — same privacy/relevance fix as the Claude Code session-start handler, #39), expands the latest 3 session summaries through `@cavemem/compress#expand` if `compressed === 1`, and joins them as `Prior context (internal): …`.
- All bridge failures are appended to `/tmp/cavemem-bridge-errors.log` via plain `appendFileSync` (`log()` — never a subprocess, never throws); missing settings/DB silently disable context priming.

## Integration

- `index.ts` imports every `register*Command` from `src/commands/` and the version define from `tsup.config.ts` (`__CAVEMEM_VERSION__`, declared in `env.d.ts`).
- `opencode-bridge.ts` is bundled as its own entry `opencodeBridge` so OpenCode can load it as a plugin without importing the bin entry; it depends on `@cavemem/compress` (expand), `@cavemem/config` (loadSettings/resolveDataDir), `@cavemem/core` (MemoryStore) and shells out to this same CLI for writes.
- The bridge's write path re-enters the CLI at `commands/hook.ts` (`hook run … --ide opencode`), closing the loop between the two entries.
