# packages/hooks/src/handlers/

## Responsibility

One function per IDE lifecycle event, each taking `(store: MemoryStore, input: HookInput)` and doing exactly one write-shaped job through `MemoryStore`:

| Handler | File | Writes | Returns |
|---|---|---|---|
| `sessionStart` | `session-start.ts` | `startSession` | prior-session context string |
| `userPromptSubmit` | `user-prompt-submit.ts` | `addObservation(kind: 'user_prompt')` | `''` |
| `postToolUse` | `post-tool-use.ts` | `addObservation(kind: 'tool_use')` | void |
| `stop` | `stop.ts` | `addSummary(scope: 'turn')` | void |
| `sessionEnd` | `session-end.ts` | `addSummary(scope: 'session')` + `endSession` | void |

## Design

- **`sessionStart` is idempotent** — Claude Code re-fires SessionStart on resume/clear/compact with the same `session_id`, so `store.startSession` must tolerate duplicates. Context injection happens only when `input.source === 'startup'` (on resume/clear/compact the agent already has its own context; a "Prior-session context" preface would be noisy and possibly stale). The fetch intentionally widens to `store.storage.listSessions(20)` before filtering by `cwd` and slicing to 3 — without the headroom a project that hasn't been the most recently used on the machine would routinely get zero hints (issue #39). Each hint attaches at most one summary via `store.storage.listSummaries`, joined under a `## Prior-session context` heading.
- **`userPromptSubmit` deliberately returns `''`** — retrieval augmentation is driven through MCP, not this hook, so agents that don't use MCP still get a fast path. Its only job is persisting the prompt as a `user_prompt` observation.
- **`postToolUse` is the defensive hot path.** Three gates before any write: (1) tool filtering via `capture.excludeTools` / `capture.includeTools` globs (`isToolExcluded`, `matchesGlob` from config); (2) privacy — `privacy.excludePatterns` is checked against dedicated path fields (`PATH_KEYS`: `file_path`, `path`, `notebook_path`) *and* a bounded whitespace-token scan (`PATH_LIKE_TOKEN_RE` over `MAX_SCAN_LEN` = 8000 chars) of the stringified input/output, so paths embedded in free-form strings like a Bash `command` are caught too (`candidatePaths` / `isPathExcluded`); excluded content returns silently with no log trace, per the privacy rule. (3) an empty body check. What's written is `"<tool> input=… output=…"` sliced to 4000 chars, with `stringifyShort` capping each side at 500 chars and `safeStringify` capping giant leaf strings *during* serialization (a multi-MB file payload must not pay full stringify cost only to be sliced after).
- **`stop` reads `turn_summary ?? last_assistant_message`** (the same legacy/Claude-Code alias pattern as `HookInput`) and stores it as a turn-scope summary; empty/whitespace-only summaries are no-ops.
- **`sessionEnd` rolls up** the session's turn-scope summaries — the first 20, newline-joined — into a single session-scope summary before `endSession`; with no turns it just ends the session.

## Flow

`runHook` dispatch → handler → one or two synchronous `MemoryStore` calls → SQLite write inside the store (which routes all prose through `@cavemem/compress` before storage). Nothing here reads the DB except `sessionStart` (hints) and `sessionEnd` (rollup), both via `store.storage`.

## Integration

- Consumes `store.settings.capture` / `store.settings.privacy` (typed by `@cavemem/config`) for filtering and `matchesGlob` for pattern checks.
- Handler selection happens in `../runner.ts`; handlers are also exported individually from the package root for direct use in tests.
- Round-trip with the rollup chain: `userPromptSubmit`/`postToolUse` observations and `stop` turn summaries are what `sessionEnd` aggregates and what `sessionStart` surfaces as prior-session context.
- Covered by `packages/hooks/test/post-tool-use.test.ts` (privacy/exclusion/bounds) and `test/runner.test.ts`.
