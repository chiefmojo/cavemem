# WP #222 — OpenCode Remote Priming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In remote mode, OpenCode prior-context priming fetches session-summary hints from the worker (`GET /api/context`) instead of reading the always-empty client-local `data.db` (OpenProject WP #222).

**Architecture:** Extract the #209-corrected hint scan out of `sessionStart` into a shared `buildPriorContext` builder in `packages/hooks`; expose it via a new bearer-auth'd `GET /api/context` route on the worker; branch the opencode bridge's `getRecentContext()` on remote mode. Local-mode paths stay byte-identical.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest, Hono (worker), pnpm workspaces, `@cavemem/compress` (`expand`).

**Spec:** `docs/superpowers/specs/2026-09-06-wp222-opencode-remote-priming-design.md`

## Global Constraints

- Local-mode bridge behavior and `sessionStart` output are byte-identical to today; existing `packages/hooks/test/runner.test.ts` must pass **unmodified** as the proof.
- Fail-open: plugin init and `getRecentContext` never throw; worst case is one ≤ `remote.timeoutMs` (default 1500 ms) round-trip per fetch — the `queriedSessions` guard suppresses repeat fetches only until the existing `session.idle`/`session.deleted` reset re-enables the session, not for the session's entire lifetime. The IDE is never blocked beyond that.
- The remote token is never logged.
- `GET /api/context`: behind the worker's existing `bearerAuth` middleware (no extra wiring); `cwd` required → `400 { error: 'cwd is required' }`; unexpected errors → `500 { error: string }` (same envelope as `/api/hooks` 4xx — there is no shared error middleware to inherit); route hardcodes `endedOnly: true` + `preferSessionScope: true` (the bridge's ended-sessions-only and session-scope-preferred guarantees).
- Builder accounting: an `endedOnly` skip consumes a `MAX_CANDIDATES_SCANNED` slot (like a summary-less candidate); `excludeSessionId` is transparent (pre-scan check).
- File naming kebab-case; imports use ESM `.js` suffixes; no upward/sideways package imports — cross-package only via `package.json#exports`.
- Biome owns formatting: run `pnpm lint:fix` before committing if lint complains.
- Every commit: `--author="Erick <chiefmojo@chiefmojo.com>"`, Conventional Commit subject, **no** `Co-Authored-By` trailer.
- Per-package test command: `pnpm --filter <pkg> test`. Merge gates at the end: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

---

### Task 1: Shared `buildPriorContext` builder + `sessionStart` refactor (`packages/hooks`)

**Files:**
- Create: `packages/hooks/src/prior-context.ts`
- Modify: `packages/hooks/src/index.ts` (add one export line, mirroring L6's `sessionStart` line)
- Modify: `packages/hooks/src/handlers/session-start.ts` (replace the scan loop at L32–43 with a builder call; keep the file's existing comments where still accurate)
- Test: `packages/hooks/test/prior-context.test.ts` (new file)

**Interfaces:**
- Consumes (existing): `store.storage.listSessions(limit: number, opts?: { cwd?: string | null }): SessionRow[]` (`packages/storage/src/storage.ts:171`); `store.storage.listSummaries(sessionId: string): SummaryRow[]` (`storage.ts:295`); `SessionRow.ended_at: number | null`; `SummaryRow.compressed: 0 | 1`.
- Produces (Tasks 2 and 3 rely on this): `buildPriorContext(store: MemoryStore, opts: { cwd: string | null; excludeSessionId?: string; endedOnly?: boolean; preferSessionScope?: boolean }): PriorContextHint[]` where `PriorContextHint = { sessionId: string; content: string; compressed: boolean }`, exported from `@cavemem/hooks` (no `package.json` exports edit needed — single tsup entry re-exports via `index.ts`).

- [ ] **Step 1: Write the failing tests**

Create `packages/hooks/test/prior-context.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { buildPriorContext } from '../src/prior-context.js';

describe('buildPriorContext', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cavemem-prior-context-'));
    store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Distinct started_at per session (listSessions orders by started_at DESC).
  const tick = () => new Promise((r) => setTimeout(r, 2));

  // Deterministic seeding: storage.insertSummary (not MemoryStore.addSummary)
  // so the stored `compressed` flag is exactly what the test sets, with no
  // redaction/compression pass in between.
  async function seedEnded(
    id: string,
    cwd: string | null,
    summary?: { content: string; compressed?: 0 | 1; scope?: 'turn' | 'session' },
  ): Promise<void> {
    await tick();
    store.startSession({ id, ide: 'opencode', cwd, metadata: null });
    store.endSession(id);
    if (summary) {
      store.storage.insertSummary({
        session_id: id,
        scope: summary.scope ?? 'session',
        content: summary.content,
        compressed: summary.compressed === 1,
        intensity: null,
      });
    }
  }

  it('scopes to cwd, orders newest first, excludes transparently', async () => {
    await seedEnded('a-old', '/proj', { content: 'old' });
    await seedEnded('a-new', '/proj', { content: 'new' });
    await seedEnded('b', '/other', { content: 'other cwd' });
    await seedEnded('a-excluded', '/proj', { content: 'excluded' });

    const hints = buildPriorContext(store, { cwd: '/proj', excludeSessionId: 'a-excluded' });
    expect(hints.map((h) => h.sessionId)).toEqual(['a-new', 'a-old']);
  });

  it('excluded session does not consume a scan-cap slot', async () => {
    // Oldest summarized session, then the excluded one, then 9 bare ones.
    // Scan order (newest first): bare-8..bare-0 (9 slots), excluded
    // (transparent, no slot), has-summary (10th slot) → 1 hint. If the
    // exclusion counted against the cap, the scan would stop at 10 slots
    // before reaching it → 0 hints.
    await seedEnded('has-summary', '/proj', { content: 'found me' });
    await seedEnded('excluded', '/proj', { content: 'excluded' });
    for (let i = 0; i < 9; i++) await seedEnded(`bare-${i}`, '/proj');

    const hints = buildPriorContext(store, { cwd: '/proj', excludeSessionId: 'excluded' });
    expect(hints.map((h) => h.content)).toEqual(['found me']);
  });

  it('endedOnly skips in-flight sessions and those skips count against the scan cap', async () => {
    await seedEnded('ended-summarized', '/proj', { content: 'too far back' });
    for (let i = 0; i < 10; i++) {
      await tick();
      store.startSession({ id: `live-${i}`, ide: 'opencode', cwd: '/proj', metadata: null });
      store.storage.insertSummary({
        session_id: `live-${i}`,
        scope: 'turn',
        content: `in-flight ${i}`,
        compressed: false,
        intensity: null,
      });
    }

    // 10 in-flight candidates exhaust the 10-slot cap; the ended summarized
    // session sits just beyond it → nothing.
    expect(
      buildPriorContext(store, { cwd: '/proj', endedOnly: true }).map((h) => h.sessionId),
    ).toEqual([]);

    // Without the flag the newest candidate is eligible (sessionStart parity).
    expect(buildPriorContext(store, { cwd: '/proj' }).map((h) => h.sessionId)[0]).toBe('live-9');
  });

  it('caps at 3 hints, takes the first summary of any scope, normalizes compressed', async () => {
    await seedEnded('s1', '/proj', { content: 'h1', compressed: 1 });
    await seedEnded('s2', '/proj', { content: 'h2', compressed: 0 });
    await seedEnded('s3', '/proj', { content: 'h3', compressed: 1 });
    await seedEnded('s4', '/proj', { content: 'h4', scope: 'turn' });

    const hints = buildPriorContext(store, { cwd: '/proj' });
    expect(hints.map((h) => h.sessionId)).toEqual(['s4', 's3', 's2']);
    expect(hints[0]).toEqual({ sessionId: 's4', content: 'h4', compressed: false });
    expect(hints[1]?.compressed).toBe(true);
    expect(hints[2]?.compressed).toBe(false);
  });

  it('returns [] when nothing matches', () => {
    expect(buildPriorContext(store, { cwd: '/nothing' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @cavemem/hooks test -- prior-context`
Expected: FAIL — cannot resolve `../src/prior-context.js` (module does not exist yet).

- [ ] **Step 3: Implement the builder**

Create `packages/hooks/src/prior-context.ts`:

```ts
import type { MemoryStore } from '@cavemem/core';

// Cap on how many of the most-recent same-cwd sessions the hint scan walks
// past before giving up — bounds how stale injected context can get when the
// recent sessions carry no summaries. Moved here from session-start.ts so the
// HTTP read path (WP #222) enforces the same bound.
const MAX_CANDIDATES_SCANNED = 10;
const MAX_HINTS = 3;

export interface PriorContextHint {
  sessionId: string;
  content: string;
  compressed: boolean;
}

export interface BuildPriorContextOptions {
  /** Scope candidates to this cwd (SQL-side). */
  cwd: string | null;
  /** Session to exclude from candidates. Transparent: no scan-cap cost. */
  excludeSessionId?: string;
  /**
   * Skip candidates whose session never ended. Each skip still consumes a
   * scan-cap slot, so unbounded in-flight sessions can't push the scan
   * arbitrarily far back (WP #222 review, item A1).
   */
  endedOnly?: boolean;
  /**
   * Prefer the session-scope rollup when a candidate has one, falling back to
   * the newest summary of any scope. Matches the bridge local path's
   * selection; `sessionStart` omits the flag and keeps its historical
   * first-any-scope behavior (WP #222 PR review).
   */
  preferSessionScope?: boolean;
}

export function buildPriorContext(
  store: MemoryStore,
  opts: BuildPriorContextOptions,
): PriorContextHint[] {
  const recent = store.storage.listSessions(20, { cwd: opts.cwd });
  const hints: PriorContextHint[] = [];
  let scanned = 0;
  for (const s of recent) {
    if (s.id === opts.excludeSessionId) continue;
    if (scanned >= MAX_CANDIDATES_SCANNED) break;
    scanned++;
    if (opts.endedOnly && s.ended_at === null) continue;
    const summaries = store.storage.listSummaries(s.id);
    const summary = opts.preferSessionScope
      ? (summaries.find((x) => x.scope === 'session') ?? summaries[0])
      : summaries[0];
    if (!summary) continue;
    hints.push({
      sessionId: s.id,
      content: summary.content,
      compressed: summary.compressed === 1,
    });
    if (hints.length === MAX_HINTS) break;
  }
  return hints;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @cavemem/hooks test -- prior-context`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the export**

In `packages/hooks/src/index.ts`, directly after the `sessionStart` export line (L6), add:

```ts
export { buildPriorContext } from './prior-context.js';
```

- [ ] **Step 6: Refactor `sessionStart` onto the builder**

Replace the scan block in `packages/hooks/src/handlers/session-start.ts` (the `const recent = …` through `return` at L32–45) with:

```ts
import type { MemoryStore } from '@cavemem/core';
import { buildPriorContext } from '../prior-context.js';
import type { HookInput } from '../types.js';
```

(top imports — add the `buildPriorContext` import; then the body after the `input.source` guard):

```ts
  // Same scan as before (WP #209): SQL cwd-scoped 20-row window, at most 10
  // candidates scanned, summary-less candidates skipped before the 3-hint
  // cap. Now shared with the worker's /api/context read path (WP #222).
  // No `endedOnly` — the handler has never filtered on ended sessions.
  const hints = buildPriorContext(store, {
    cwd: input.cwd ?? null,
    excludeSessionId: input.session_id,
  });
  if (hints.length === 0) return '';
  return `## Prior-session context\n${hints.map((h) => h.content).join('\n---\n')}`;
```

Keep the file's existing comments above this block that still explain window semantics (the #209 paragraph at L21–31), trimming any sentence that now describes code living in `prior-context.ts`.

- [ ] **Step 7: Verify behavior preservation — full hooks suite, unmodified**

Run: `pnpm --filter @cavemem/hooks test`
Expected: PASS — including the existing `runner.test.ts` session-start cases **with no edits to that file**.

- [ ] **Step 8: Commit**

```bash
git add packages/hooks/src/prior-context.ts packages/hooks/src/index.ts packages/hooks/src/handlers/session-start.ts packages/hooks/test/prior-context.test.ts
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat: extract shared prior-context builder (WP #222)"
```

---

### Task 2: Worker `GET /api/context` route (`apps/worker`)

**Files:**
- Modify: `apps/worker/src/server.ts` (import line L9; new route after `/api/search`, ~L115)
- Modify: `apps/worker/test/server.test.ts` (append tests alongside the existing route tests, same top-level `it` style)

**Interfaces:**
- Consumes: `buildPriorContext` from `@cavemem/hooks` (Task 1).
- Produces: `GET /api/context?cwd=<dir>&exclude=<sessionId>` → `200 { hints: Array<{ sessionId: string; content: string; compressed: boolean }> }`; `400 { error: 'cwd is required' }` when `cwd` missing/empty; `500 { error: string }` on unexpected failure. Route is bearer-only via the existing middleware chain (L65–70) — no security wiring changes.

- [ ] **Step 1: Write the failing tests**

In `apps/worker/test/server.test.ts`, add a seeding helper and tests next to the existing route tests (the file already defines `store`, `req()`, `apiReq()`, `TOKEN`, and rebuilds `store` in `beforeEach`):

```ts
const tick = () => new Promise((r) => setTimeout(r, 2));

async function seedContextSession(
  id: string,
  cwd: string,
  opts: {
    ended?: boolean;
    summary?: { content: string; compressed?: 0 | 1; scope?: 'turn' | 'session' };
  } = {},
): Promise<void> {
  await tick();
  store.startSession({ id, ide: 'opencode', cwd, metadata: null });
  if (opts.summary) {
    store.storage.insertSummary({
      session_id: id,
      scope: opts.summary.scope ?? 'session',
      content: opts.summary.content,
      compressed: opts.summary.compressed === 1,
      intensity: null,
    });
  }
  if (opts.ended !== false) store.endSession(id);
}

it('context: returns 401 without a token', async () => {
  const res = await req('/api/context?cwd=/proj');
  expect(res.status).toBe(401);
});

it('context: returns 400 without cwd', async () => {
  const res = await apiReq('/api/context');
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('cwd is required');
});

it('context: returns cwd-scoped ended-session hints with compressed normalized', async () => {
  await seedContextSession('ctx-a', '/proj', { summary: { content: 'alpha', compressed: 1 } });
  await seedContextSession('ctx-new', '/proj', { summary: { content: 'newest' } });
  await seedContextSession('ctx-other', '/elsewhere', { summary: { content: 'beta' } });

  const res = await apiReq('/api/context?cwd=/proj&exclude=ctx-new');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    hints: [{ sessionId: 'ctx-a', content: 'alpha', compressed: true }],
  });
});

it('context: empty store yields an empty hints array', async () => {
  const res = await apiReq('/api/context?cwd=/proj');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ hints: [] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @cavemem/worker test`
Expected: FAIL — the three positive/validation tests return 404 (route missing). The 401 test may already pass (middleware answers before routing); that's fine — it documents the contract.

- [ ] **Step 3: Implement the route**

In `apps/worker/src/server.ts`, extend the hooks import (L9) and add the route directly after the `/api/search` handler (L111–115):

```ts
import { buildPriorContext, type HookInput, type HookName, runHook } from '@cavemem/hooks';
```

```ts
  // Prior-session priming for remote clients (WP #222): the opencode bridge
  // fetches its system-prompt hints here instead of reading the empty
  // client-local store. Ended sessions only, and session-scope summaries
  // preferred (any-scope fallback) — both are the bridge's local-path
  // guarantees; scan caps and exclusion semantics live in buildPriorContext.
  // 500s use the same { error } envelope as the /api/hooks 4xx responses;
  // there is no shared error middleware to inherit.
  app.get('/api/context', (c) => {
    const cwd = c.req.query('cwd');
    if (!cwd) return c.json({ error: 'cwd is required' }, 400);
    const exclude = c.req.query('exclude');
    try {
      return c.json({
        hints: buildPriorContext(store, {
          cwd,
          // Conditional spread: exactOptionalPropertyTypes rejects an explicit
          // `undefined`; absent/empty `exclude` must stay absent.
          ...(exclude ? { excludeSessionId: exclude } : {}),
          endedOnly: true,
          preferSessionScope: true,
        }),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @cavemem/worker test`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/server.ts apps/worker/test/server.test.ts
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "feat: add GET /api/context prior-context endpoint (WP #222)"
```

---

### Task 3: Bridge remote priming branch (`apps/cli`)

**Files:**
- Modify: `apps/cli/src/opencode-bridge.ts` (imports L1–8; `LOG_PATH` L84; store init L112–123; `getRecentContext` L157–200)
- Test: `apps/cli/test/opencode-bridge.test.ts` (new file)

**Interfaces:**
- Consumes: `checkedRemoteTarget(settings): RemoteTarget | null` from `./util/remote.js` (returns `null` in local mode, **throws** on invalid `remote.url`); `RemoteTarget = { url: string; token: string | undefined; timeoutMs: number }` from `@cavemem/hooks`; `expand(content: string): string` from `@cavemem/compress`; the `GET /api/context` contract from Task 2.
- Produces: unchanged plugin surface — `getRecentContext` still returns a string; remote mode injects `Prior context (internal): ${hints.join(' | ')}`, byte-identical to the local path's format.

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/test/opencode-bridge.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';

type SystemTransform = (
  input: { sessionID?: string; model: unknown },
  output: { system: string[] },
) => Promise<void>;

describe('opencode-bridge prior-context priming', () => {
  let home: string;
  let origHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cavemem-bridge-test-'));
    origHome = process.env.CAVEMEM_HOME;
    process.env.CAVEMEM_HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origHome === undefined) delete process.env.CAVEMEM_HOME;
    else process.env.CAVEMEM_HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function loadBridge(settings: Record<string, unknown>): Promise<{
    'experimental.chat.system.transform': SystemTransform;
  }> {
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ embedding: { provider: 'none' }, ...settings }),
    );
    const mod = await import('../src/opencode-bridge.js');
    const hooks = (await mod.default({ $: {} as never, directory: '/proj' })) as Record<
      string,
      SystemTransform
    >;
    return { 'experimental.chat.system.transform': hooks['experimental.chat.system.transform'] };
  }

  async function prime(hooks: { 'experimental.chat.system.transform': SystemTransform }) {
    const output = { system: [] as string[] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses-1', model: {} }, output);
    return output.system;
  }

  it('primes from the worker in remote mode', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          hints: [{ sessionId: 'old-1', content: 'earlier session solved X', compressed: false }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/context');
    expect(url.searchParams.get('cwd')).toBe('/proj');
    expect(url.searchParams.get('exclude')).toBe('ses-1');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(system).toContain('Prior context (internal): earlier session solved X');
  });

  it('expands compressed hints client-side', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ hints: [{ sessionId: 'old-1', content: 'plain note', compressed: true }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    expect(system).toContain('Prior context (internal): plain note');
  });

  it('fail-open: remote 500 yields no priming and no throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
  });

  it('degrades to no priming on invalid remote.url without throwing at init', async () => {
    // canonicalRemoteUrl rejects URLs with a path/query/fragment;
    // checkedRemoteTarget rethrows — init must catch it, not crash the plugin.
    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777/has/path', token: 'tok' } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
  });

  it('local mode reads the client-local store exactly as before', async () => {
    const dbPath = join(home, 'data.db');
    const seed = new MemoryStore({ dbPath, settings: defaultSettings });
    seed.startSession({ id: 'local-1', ide: 'opencode', cwd: '/proj', metadata: null });
    seed.endSession('local-1');
    seed.storage.insertSummary({
      session_id: 'local-1',
      scope: 'session',
      content: 'local summary text',
      compressed: false,
      intensity: null,
    });
    seed.close();

    const system = await prime(await loadBridge({ dataDir: home }));

    expect(system).toContain('Prior context (internal): local summary text');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter cavemem test -- opencode-bridge`
Expected: FAIL — the three remote tests fail (bridge has no remote branch: fetch never called / no `Prior context` string); the local test may already pass (existing behavior). The invalid-`remote.url` test passes trivially today (init ignores remote settings) — it pins the new guard so the refactor can't regress it.

- [ ] **Step 3: Implement the bridge changes**

In `apps/cli/src/opencode-bridge.ts`:

3a. Imports — add `tmpdir` to the `node:os`-free import block and two new imports after the existing ones (keep `expand`, `loadSettings`, `resolveDataDir`, `MemoryStore`):

```ts
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expand } from '@cavemem/compress';
import { loadSettings, resolveDataDir } from '@cavemem/config';
import type { RemoteTarget } from '@cavemem/hooks';
import { MemoryStore } from '@cavemem/core';
import { checkedRemoteTarget } from './util/remote.js';
```

3b. Log path (L84), plus a module-scope logging helper — error **name** only, never the message:

```ts
const LOG_PATH = join(tmpdir(), 'cavemem-bridge-errors.log');

// Error name only, never the message: remote-mode exception messages can
// embed the authorization header value (e.g. undici's invalid-header
// TypeError quotes the full `Bearer …` string) or raw settings content
// (JSON.parse failures), and the remote token must never reach the log.
function errorName(err: unknown): string {
  return (err as { name?: string })?.name || 'Error';
}
```

3c. Replace the store-init block (L112–123) with the guarded remote/local init:

```ts
  // Prior-session priming source. Remote mode: prime from the worker via
  // /api/context — the client-local data.db is empty/stale here (WP #222),
  // and opening it would also create a junk empty data.db on remote clients.
  // Local mode: read the local store exactly as before. Both settings load
  // and target resolution are guarded: checkedRemoteTarget throws on an
  // invalid remote.url, and a throw here would take down every bridge hook —
  // including the fire-and-forget writes — so we degrade to no priming at all.
  let store: MemoryStore | undefined;
  let remote: RemoteTarget | undefined;
  try {
    const settings = loadSettings();
    const target = checkedRemoteTarget(settings);
    if (target) {
      remote = target;
    } else {
      const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
      store = new MemoryStore({ dbPath, settings });
    }
  } catch (err) {
    // Error name only: settings/JSON.parse errors can quote file content
    // containing the token; the message must never reach the log.
    log(`init degraded, priming disabled: ${errorName(err)}`);
  }
```

3d. Replace `getRecentContext` (L157–200) with the two-branch version — the once-per-session guard and the injected-string format stay exactly as they are:

```ts
  async function getRecentContext(sessionID: string): Promise<string> {
    if (!sessionID) return '';
    if (queriedSessions.has(sessionID)) return '';
    queriedSessions.add(sessionID);

    try {
      if (remote) {
        // /api/context rejects unscoped reads by design (400 guaranteed);
        // the local path treats a falsy directory as "no scoping" and still
        // primes. Skipping beats a doomed round-trip (WP #222 PR review).
        if (!directory) {
          log(`retrieval for ${sessionID}: skipped (no directory to scope by)`);
          return '';
        }
        const u = new URL('/api/context', remote.url);
        u.searchParams.set('cwd', directory);
        u.searchParams.set('exclude', sessionID);
        const res = await fetch(u, {
          headers: { authorization: `Bearer ${remote.token ?? ''}` },
          signal: AbortSignal.timeout(remote.timeoutMs),
        });
        if (!res.ok) {
          // Status is a bare number — safe to log. Never log the exception
          // message or body here: they can embed the authorization value.
          log(`context fetch failed: ${res.status}`);
          return '';
        }
        const body = (await res.json()) as {
          hints?: Array<{ sessionId: string; content: string; compressed: boolean }>;
        };
        const hints = (body.hints ?? [])
          .map((h) => (h.compressed ? expand(h.content) : h.content).trim())
          .filter((t) => t.length > 0);

        log(`retrieval for ${sessionID}: ${hints.length} hints found`);
        if (hints.length === 0) return '';

        const context = `Prior context (internal): ${hints.join(' | ')}`;
        log(`injected ${context.length} chars`);
        return context;
      }

      if (!store) return '';

      const sessions = store.storage.listSessions(50);
      // Scope to the current project directory — otherwise opening OpenCode
      // in project A can inject summaries from an unrelated project B
      // session (privacy + relevance bug; see the same fix applied to the
      // Claude Code session-start handler in #39). Falls back to unscoped
      // behaviour only if we somehow have no directory to compare against.
      const ended = sessions
        .filter(
          (s) => s.id !== sessionID && s.ended_at !== null && (!directory || s.cwd === directory),
        )
        .sort((a, b) => b.started_at - a.started_at)
        .slice(0, 3);

      const hints: string[] = [];
      for (const session of ended) {
        const summaries = store.storage.listSummaries(session.id);
        const sessionSummary = summaries.find((s) => s.scope === 'session');
        if (!sessionSummary) continue;

        const raw = sessionSummary.content;
        const text = sessionSummary.compressed === 1 ? expand(raw) : raw;
        if (text.trim()) hints.push(text.trim());
      }

      log(`retrieval for ${sessionID}: ${hints.length} summaries found`);
      if (hints.length === 0) return '';

      const context = `Prior context (internal): ${hints.join(' | ')}`;
      log(`injected ${context.length} chars`);
      return context;
    } catch (err) {
      if (remote) {
        // Error name only — remote exception messages can embed the
        // authorization header value (e.g. invalid-header TypeErrors).
        log(`retrieval error: ${errorName(err)}`);
      } else {
        // Local store errors cannot contain the remote token — keep detail.
        const msg = (err as Error)?.message || String(err);
        log(`retrieval error: ${msg}`);
      }
      return '';
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter cavemem test -- opencode-bridge`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full CLI suite (no regressions in other commands)**

Run: `pnpm --filter cavemem test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/opencode-bridge.ts apps/cli/test/opencode-bridge.test.ts
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "fix: prime opencode remote sessions from the worker (WP #222)"
```

---

### Task 4: Docs, changeset, merge gates

**Files:**
- Modify: `docs/remote.md` (endpoint list — next to the `/api/search` entry)
- Modify: `apps/worker/codemap.md`, `apps/cli/codemap.md`, `packages/hooks/codemap.md` (one line each, matching each file's existing line style)
- Create: `.changeset/wp222-remote-priming.md`

**Interfaces:** none (documentation + release bookkeeping).

- [ ] **Step 1: Document the endpoint**

In `docs/remote.md`, add to the endpoint list, next to the `/api/search` entry:

```
GET /api/context?cwd=<dir>&exclude=<sessionId> — prior-session summary hints for OpenCode priming (bearer; 400 without cwd; ended sessions only; scan cap 10; max 3 hints; session-scope summaries preferred)
```

- [ ] **Step 2: Update the three codemaps**

One line each, placed in the section that lists the module's responsibilities (match each file's existing bullet/line style):

- `apps/worker/codemap.md`: `GET /api/context — prior-session priming hints for remote OpenCode (bearer, endedOnly, scan-capped; WP #222)`
- `apps/cli/codemap.md`: update the bridge line (currently says priming "reads the store directly") to: `opencode-bridge.ts — plugin; writes fire-and-forget via CLI hooks; priming reads the local store, or /api/context on the worker in remote mode (WP #222)`
- `packages/hooks/codemap.md`: `prior-context.ts — shared prior-session hint scan (sessionStart + worker /api/context); endedOnly skips still consume the scan cap`

- [ ] **Step 3: Add the changeset**

Create `.changeset/wp222-remote-priming.md`:

```md
---
'cavemem': patch
'@cavemem/worker': patch
'@cavemem/hooks': patch
---

Fix WP #222: OpenCode remote-mode priming fetches prior-session context from the worker (`GET /api/context`) instead of the empty client-local store. Adds the shared `buildPriorContext` builder (also now backing `sessionStart`); the bridge error log moved to `os.tmpdir()` so it works on Windows.
```

- [ ] **Step 4: Run the four merge gates**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all four pass. If lint flags formatting in touched files, run `pnpm lint:fix`, re-run the gates, and amend nothing — fold the formatting into the docs commit below.

- [ ] **Step 5: Commit**

```bash
git add docs/remote.md apps/worker/codemap.md apps/cli/codemap.md packages/hooks/codemap.md .changeset/wp222-remote-priming.md
git commit --author="Erick <chiefmojo@chiefmojo.com>" -m "docs: document /api/context priming endpoint (WP #222)"
```

---

## Verification recap (after Task 4)

- `pnpm --filter @cavemem/hooks test` — builder + unmodified session-start behavior
- `pnpm --filter @cavemem/worker test` — endpoint contract (401/400/200/empty)
- `pnpm --filter cavemem test` — bridge remote/local/fail-open/guard
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — merge gates
- Manual smoke (optional, needs a remote client): open an OpenCode session in a cwd with prior summarized sessions; `/tmp/cavemem-bridge-errors.log` (or `%TEMP%\cavemem-bridge-errors.log`) shows `retrieval for <sid>: N hints found` with N > 0, and the worker log shows the `/api/context` hit.
