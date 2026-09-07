# WP #222 — OpenCode remote-mode priming from the server

**Date:** 2026-09-06
**Status:** Approved design (pre-implementation)
**Work package:** OpenProject Memory / WP #222 — "OpenCode remote-mode priming reads the local store (always empty on remote clients)"

## Problem

`apps/cli/src/opencode-bridge.ts` `getRecentContext()` (L157–200, store init L116–123) opens a `MemoryStore` directly on the **client-local** `data.db` to build the prior-session context injected via `experimental.chat.system.transform`. In remote mode that store is empty/stale, so OpenCode sessions silently get **no prior-context injection**, while hook-based IDEs (claude-code, codex) get injection server-side via `/api/hooks` + session-start.

Evidence (from WP #222, found during WP #194 Windows-client onboarding): bridge log shows `retrieval for ses_.: 0 summaries found` on the remote client while the central store holds plenty of summaries for the same `cwd`.

`/api/search` is **not** a substitute: it returns query-driven observation hits (`{id, session_id, snippet, score, ts}`), not cwd-scoped session summaries. No existing worker endpoint exposes session summaries.

## Goals

- In remote mode, OpenCode prior-context priming reads from the server (`remote.url`) instead of the client-local store.
- Local-mode bridge behavior is byte-identical to today (injected string, selection semantics, once-per-session guard).
- Hook-IDE (claude-code / codex) injection behavior is byte-identical to today.
- Fail-open: cavemem never blocks or errors the IDE; token never leaks into logs.

## Non-goals

- Changing the write path (hooks stay fire-and-forget; no stdout capture from the CLI subprocess).
- Making `sessionStart` expand compressed summaries (hook IDEs keep receiving stored/compressed text).
- Unifying local vs remote opencode summary selection (local keeps session-scope-only; remote adopts the shared builder's semantics).
- Any changes to `/mcp`, `/api/search`, or the viewer.

## Design

### 1. Architecture & data flow

Three pieces: a shared prior-context builder in `packages/hooks`, a new read route on the worker, and a remote branch in the bridge.

```
OpenCode system.transform
  └─ bridge: checkedRemoteTarget(settings) non-null?
       ├─ remote: GET {remote.url}/api/context?cwd=…&exclude=<sessionID>
       │     (Bearer remote.token, AbortSignal.timeout(remote.timeoutMs))
       │     └─ worker: bearerAuth → buildPriorContext(store, …) → { hints: [...] }
       │     └─ bridge: expand compressed hints → "Prior context (internal): …"
       └─ local: existing local-store path, untouched
```

Writes stay fire-and-forget via the CLI hook commands. The once-per-session `queriedSessions` guard applies to both branches.

### 2. Worker endpoint

`GET /api/context` in `apps/worker/src/server.ts`, registered like the other `/api/*` routes and behind the same `bearerAuth` (worker token / `remote.token` as `Authorization: Bearer`).

- Query params:
  - `cwd` — **required**; missing/empty → `400`. (An unscoped read endpoint would be a privacy regression; unlike the in-process `sessionStart` handler, which falls back to unscoped on null cwd, the HTTP boundary must not.)
  - `exclude` — optional sessionID to skip (the priming session itself).
- Response `200`: `{ "hints": [{ "sessionId": string, "content": string, "compressed": boolean }] }` — a faithful data view; no formatting server-side. `compressed` is normalized from the storage 0/1 flag to boolean.
- Empty result → `{ "hints": [] }`. Unexpected errors → `500 { "error": string }` — pinned to match the `/api/hooks` 4xx envelope (`{ error }`); the worker has no shared error middleware to inherit.

### 3. Shared builder (`packages/hooks/src/prior-context.ts`)

`buildPriorContext(store, { cwd, excludeSessionId, endedOnly })` moves the #209-corrected scan out of `sessionStart`:

- SQL cwd-scoped fetch: `store.storage.listSessions(20, { cwd })`.
- Skip `excludeSessionId`; scan cap `MAX_CANDIDATES_SCANNED = 10`; first summary of any scope per session (`listSummaries(s.id)[0]`); cap 3 hints.
- `endedOnly?: boolean` — when true, candidates with `ended_at === null` are skipped. The bridge passes `true` to keep its current ended-sessions-only guarantee (without it, a concurrent same-cwd window's in-flight turn summary — `listSummaries` is `ORDER BY ts DESC` across all scopes — could be injected into the other window's priming). `sessionStart` omits the flag and keeps its exact semantics. **An `endedOnly` skip consumes a `MAX_CANDIDATES_SCANNED` slot** (same accounting as a summary-less candidate): a transparent skip would let the scan walk past unboundedly many in-flight sessions and reach arbitrarily far back, defeating the cap's guarantee. `excludeSessionId` remains transparent (pre-scan check, matching current `sessionStart` behavior).
- Returns raw rows `{ sessionId, content, compressed }` (boolean), no formatting.

`sessionStart` (`packages/hooks/src/handlers/session-start.ts`) refactors onto the builder (omitting `endedOnly`) and re-renders its current output (`## Prior-session context\n` + hints joined `\n---\n`, raw stored content). **Existing session-start tests must pass unmodified** — that is the behavior-preservation proof.

Exported through `packages/hooks` package exports (worker already depends on `@cavemem/hooks`).

### 4. Bridge changes (`apps/cli/src/opencode-bridge.ts`)

- Settings load and `checkedRemoteTarget(settings)` both run inside one guarded init: `checkedRemoteTarget` **throws** on an invalid `remote.url` (`canonicalRemoteUrl` rejects path/query/fragment), so a throw here is caught, logged, and degrades to *no priming at all* — plugin init never throws, and the fire-and-forget write hooks are unaffected (fail-open goal). When a target resolves, **no local `MemoryStore` is opened at all** — this also stops creating a junk empty `data.db` on remote clients.
- `getRecentContext` branches:
  - Remote: one fetch to `/api/context` with `cwd` = the plugin `directory` — deliberately the same value the local path scopes reads by (`s.cwd === directory`), not the write hook's `session.directory || directory`; `exclude` = current sessionID; bearer header + `AbortSignal.timeout(remote.timeoutMs)`; same pattern as `remoteSearch`. Expand hints with `compressed === true` client-side (the `expand` import stays), format `Prior context (internal): ${hints.join(' | ')}` — the identical string local mode produces today.
  - Local: existing code path, untouched.
- Logging to `join(os.tmpdir(), 'cavemem-bridge-errors.log')` replaces the hardcoded `/tmp/...` (`LOG_PATH`, L84): on Windows the hardcoded path does not exist, `appendFileSync` throws, and `log()` swallows it — zero diagnostics on the exact platform this WP was found on. Same log lines as before (`retrieval for <sid>: N hints` / error lines).
- Known deferral (pre-existing, both modes, out of scope): the read scopes by the plugin `directory` while the session-start write records `cwd: session.directory || directory` (L218); when they diverge (session opened in a subdir, multi-root workspace) the read won't match those rows. Conscious deferral, not an oversight.

### 5. Error handling & privacy

- Fail-open: timeout, 401, non-2xx, malformed JSON → log + return `''`; the IDE never waits on cavemem beyond the configured timeout.
- Worst-case added latency: one ≤ `remote.timeoutMs` (default 1500 ms) round-trip per fetch. The `queriedSessions` guard suppresses repeat fetches only until the existing `session.idle`/`session.deleted` reset re-enables the session — not for the session's entire lifetime.
- Token never logged; the endpoint requires `cwd`, and scoping is enforced server-side in SQL.
- Host/Origin allowlist and bearer auth apply to the new route as to all `/api/*` routes.

### 6. Tests, docs, gates

- Worker (`apps/worker/test/server.test.ts`, `buildApp` + `apiReq` conventions):
  - 401 without token; 400 without `cwd`; cwd-scoped hints with exclusion and scan-cap semantics; empty store → `{ hints: [] }`.
- Hooks (`packages/hooks` tests):
  - Direct unit tests for `buildPriorContext` (cwd scoping, exclusion, scan cap — with `endedOnly` skips counting against the cap — first-summary-any-scope selection, 3-hint cap, `compressed` normalization, `endedOnly` skipping in-flight sessions and default-off for `sessionStart` parity).
  - Existing `session-start` tests green **unmodified**.
- Bridge (new `apps/cli/test/opencode-bridge.test.ts`):
  - Remote path: temp settings home with `remote.url`/`remote.token`, stubbed `fetch` (`vi.stubGlobal`) asserting URL, auth header, and the injected system string.
  - Invalid `remote.url`: init does not throw; writes keep flowing (no priming injected).
  - Local path: temp home + `MemoryStore`-seeded DB asserting the existing string.
- Docs: `docs/remote.md` endpoint list; `codemap.md` notes for `apps/worker`, `apps/cli`, `packages/hooks`.
- Changesets for `apps/cli`, `apps/worker`, `packages/hooks`.
- Merge gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

## Alternatives considered

- **Server pre-expands and returns ready strings** — simpler client, but the server starts owning presentation; reuse by `sessionStart` would silently flip hook-IDE injection from compressed to expanded or force a format param. Rejected for coupling.
- **Approximate client-side from existing endpoints** — no summaries endpoint exists; `/api/search` and `/api/sessions/:id/observations` return observations, and `/api/sessions` + N+1 fetches can't produce summary hints. Rejected.
- **Reuse `/mcp`** — the bridge is a plugin, not an MCP client; heaviest option with no benefit. Rejected.
- **Capture the fire-and-forget session-start hook's stdout** — would couple the read path to the write path and add blocking round-trips the current design deliberately avoids. Rejected.

## References

- OpenProject WP #222 (this fix), WP #209 (SQL cwd-scoped hint scan), WP #194 (discovery context), #39 (cwd privacy scoping).
- PR chiefmojo/cavemem#6 (win32 capture/write-path fix — deliberately distinct from this read-path fix).
- Existing patterns: `apps/cli/src/util/remote.ts` (`checkedRemoteTarget`, `remoteSearch`), `apps/cli/src/commands/search.ts` remote/local branch, `packages/hooks/src/handlers/session-start.ts`.

---

## Addendum — design review (2026-09-06, Claude)

Reviewed against live code. Problem statement is accurate; endpoint/auth/privacy reasoning holds. Verified: `listSessions(20, { cwd })` runs parametrized `WHERE cwd = ?` (`packages/storage/src/storage.ts:174`), `remote.timeoutMs` default `1500` (`packages/config/src/schema.ts:57`), `checkedRemoteTarget` / `remoteSearch` patterns exist as cited, `@cavemem/hooks` is already a worker dependency, and `bearerAuth` + Host/Origin middleware covers a new `/api/context` route with no extra wiring (`apps/worker/src/server.ts:65-70`).

Action items to fold into the design before implementation (all five folded into the body 2026-09-06):

### A1 — `ended_at` filter is dropped silently (address before implementing) → folded into §3

The current bridge scan filters `s.ended_at !== null` (`apps/cli/src/opencode-bridge.ts:172`) — opencode priming uses **ended** sessions only. `sessionStart` (`packages/hooks/src/handlers/session-start.ts:35-43`) has no such filter. §3 derives the shared builder from `sessionStart`'s scan, so remote opencode loses the ended-only guarantee without the spec naming it.

Consequence: a second concurrent opencode window in the same cwd can have its in-flight **turn** summary injected into the other's priming (`listSummaries(...)[0]` is `ORDER BY ts DESC` across all scopes; turn summaries exist mid-session). `exclude` only removes the priming session itself.

Resolution: give the builder an `endedOnly?: boolean` option — `buildPriorContext(store, { cwd, excludeSessionId, endedOnly })`. Bridge passes `true`; `sessionStart` omits it and stays byte-identical. Alternative: document the drop as accepted with rationale.

### A2 — keep settings load + `checkedRemoteTarget` inside a guard → folded into §4

§4 says "settings load moves out of the store-init try/catch." `checkedRemoteTarget` **throws** on an invalid `remote.url` (`apps/cli/src/util/remote.ts:8-12`; `canonicalRemoteUrl` rejects any path/query/fragment). If the relocated load runs unguarded in the `cavememBridge()` body, a bad `remote.url` throws out of plugin init and takes down every bridge hook — including the fire-and-forget writes — which violates the fail-open goal. `getRecentContext`'s own try/catch does not cover plugin construction. The spec should state that target resolution stays wrapped and degrades to skip-priming on throw.

### A3 — `/tmp` log path is inert on Windows (fix alongside) → folded into §4

`LOG_PATH` is hardcoded `/tmp/cavemem-bridge-errors.log` (`apps/cli/src/opencode-bridge.ts:84`). WP #222 was found during Windows-client onboarding, and §4 relies on the bridge log as the diagnostic surface ("logging continues"). On Windows `/tmp` does not exist, `appendFileSync` throws, and `log()` swallows it — no diagnostics on the target platform. Switch to `os.tmpdir()`.

### A4 — pin down the 500 shape → folded into §2

§2 says "standard 500 JSON error." The worker has no shared error envelope — `/api/hooks/:event` returns `{ error: string }` on 4xx; other `/api/*` routes let Hono throw its default. Specify `{ error: string }` for the 500 (or drop "standard") so the implementer isn't chasing a convention that does not exist.

### A5 — note the cwd read/write skew as a known deferral → folded into §4

§4 deliberately scopes the read by the plugin `directory`, while the session-start write records `cwd: session.directory || directory` (`apps/cli/src/opencode-bridge.ts:218`). When `session.directory !== directory` (session opened in a subdir, multi-root workspace) the read never matches the written rows. Pre-existing in local mode and out of scope here — but worth one line so it reads as a conscious deferral, not an oversight.

### Confirmed non-issues

- Local (`scope === 'session'`) vs remote (`[0]`, any scope) selection divergence — already a stated non-goal.
- Auth/Origin on `/api/context` — path is neither `/healthz` nor a viewer path, so `bearerAuth` applies; a CLI `fetch` sends no Origin and passes like `/mcp`.
- `compressed` 0/1 → boolean normalization — consistent with `SummaryRow.compressed: number`.
- Dependency direction — `packages/hooks` importing `@cavemem/core` for `MemoryStore` is within the allowed `… → core → … → hooks` order.
