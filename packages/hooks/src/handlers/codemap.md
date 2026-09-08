# packages/hooks/src/handlers/

## Responsibility

One function per IDE lifecycle event, each taking `(store: MemoryStore, input: HookInput)` and doing exactly one write-shaped job through `MemoryStore`. Handlers are mode-agnostic: in remote mode `../runner.ts` POSTs the raw `HookInput` to the central worker instead of dispatching locally, and the worker runs these same handlers against its own injected store:

| Handler | File | Writes | Returns |
|---|---|---|---|
| `sessionStart` | `session-start.ts` | `startSession` (incl. session metadata) | prior-session context string |
| `userPromptSubmit` | `user-prompt-submit.ts` | `addObservation(kind: 'user_prompt')` | `''` |
| `postToolUse` | `post-tool-use.ts` | `addObservation(kind: 'tool_use')` | void |
| `stop` | `stop.ts` | `addSummary(scope: 'turn')` | void |
| `sessionEnd` | `session-end.ts` | `addSummary(scope: 'session')` + `endSession` | void |

## Design

- **`sessionStart` is idempotent** — Claude Code re-fires SessionStart on resume/clear/compact with the same `session_id`, so `store.startSession` must tolerate duplicates. It persists `input.metadata` into the session row (`metadata: input.metadata ?? null`) — by dispatch time `../runner.ts` has already stamped the originating machine's hostname into `metadata.host`, so sessions record where they were produced; this is what makes multi-machine (remote-mode) history distinguishable. Context injection happens only when `input.source === 'startup'` (on resume/clear/compact the agent already has its own context; a "Prior-session context" preface would be noisy and possibly stale). Hint selection is delegated to `buildPriorContext(store, { cwd: input.cwd ?? null, excludeSessionId: input.session_id })` (`../prior-context.ts`, extracted in WP #222 so the worker's `GET /api/context` priming route enforces the same bounds): the shared scan walks `store.storage.listSessions(20, { cwd })` — SQL-side cwd scoping (WP #209): an earlier machine-wide fetch with JS-side filtering let 20 unrelated recent sessions evict the current project's history and routinely returned zero hints (issue #39); the fixed-20 window still caps reach (same class as #39, strictly rarer) — scans at most `MAX_CANDIDATES_SCANNED` = 10 candidates to bound how stale injected context can get, skips summary-less candidates before the 3-hint cap (`MAX_HINTS`) so newer bare sessions can't crowd out a summarized one, and attaches one summary per hint via `store.storage.listSummaries`. `sessionStart` passes neither optional flag — no `endedOnly` (it has never filtered on ended sessions) and no `preferSessionScope` (historical newest-summary-of-any-scope pick); the worker's route passes both. Hints join under a `## Prior-session context` heading.
- **`userPromptSubmit` deliberately returns `''`** — retrieval augmentation is driven through MCP, not this hook, so agents that don't use MCP still get a fast path. Its only job is persisting the prompt as a `user_prompt` observation.
- **`postToolUse` is the defensive hot path.** Three gates before any write: (1) tool filtering via `capture.excludeTools` / `capture.includeTools` globs (`isToolExcluded`, `matchesGlob` from config); (2) privacy — `privacy.excludePatterns` is checked against dedicated path fields (`PATH_KEYS`: `file_path`, `path`, `notebook_path`) *and* a bounded whitespace-token scan (`PATH_LIKE_TOKEN_RE` over `MAX_SCAN_LEN` = 8000 chars) of the stringified input/output, so paths embedded in free-form strings like a Bash `command` are caught too (`candidatePaths` / `isPathExcluded`); excluded content returns silently with no log trace, per the privacy rule. (3) an empty body check. What's written is `"<tool> input=… output=…"` sliced to 4000 chars, with `stringifyShort` capping each side at 500 chars and `safeStringify` capping giant leaf strings *during* serialization (a multi-MB file payload must not pay full stringify cost only to be sliced after).
- **`stop` reads `turn_summary ?? last_assistant_message`** (the same legacy/Claude-Code alias pattern as `HookInput`) and stores it as a turn-scope summary; empty/whitespace-only summaries are no-ops that, at `logLevel: 'debug'`, emit one structured stderr line (`{ hook: 'stop', dropped: 'missing-summary', session_id }`) so a stale bridge plugin's silent capture gap is visible.
- **`sessionEnd` rolls up** the session's turn-scope summaries — the first 20, newline-joined — into a single session-scope summary before `endSession`; with no turns it just ends the session.

## Flow

`runHook` dispatch → handler → one or two synchronous `MemoryStore` calls → SQLite write inside the store (which routes all prose through `@cavemem/compress` before storage). Nothing here reads the DB except `sessionStart` (hints, via the shared `../prior-context.ts#buildPriorContext` scan) and `sessionEnd` (rollup), both through `store.storage`. Nothing here touches the network either — in remote mode the POST, spooling, and replay all happen in `../runner.ts` before (or instead of) any handler runs.

## Integration

- Consumes `store.settings.capture` / `store.settings.privacy` (typed by `@cavemem/config`) for filtering and `matchesGlob` for pattern checks.
- Handler selection happens in `../runner.ts`; handlers are also exported individually from the package root for direct use in tests.
- Round-trip with the rollup chain: `userPromptSubmit`/`postToolUse` observations and `stop` turn summaries are what `sessionEnd` aggregates and what `sessionStart` surfaces as prior-session context.
- Covered by `packages/hooks/test/post-tool-use.test.ts` (privacy/exclusion/bounds), `test/stop.test.ts` (dropped-summary diagnostics + turn-summary write), `test/prior-context.test.ts` (the `sessionStart` hint scan), and `test/runner.test.ts`.
