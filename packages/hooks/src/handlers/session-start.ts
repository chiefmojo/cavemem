import type { MemoryStore } from '@cavemem/core';
import { buildPriorContext } from '../prior-context.js';
import type { HookInput } from '../types.js';

export async function sessionStart(store: MemoryStore, input: HookInput): Promise<string> {
  // Idempotent: Claude Code re-fires SessionStart on resume/clear/compact with
  // the same session_id. We must not blow up on the duplicate.
  store.startSession({
    id: input.session_id,
    ide: input.ide ?? 'unknown',
    cwd: input.cwd ?? null,
    metadata: input.metadata ?? null,
  });
  // For resume/clear/compact the agent already has its own context; injecting
  // a "Prior-session context" preface would be noisy and possibly stale.
  if (input.source && input.source !== 'startup') return '';
  // Scope the fetch to the current cwd in SQL (WP #209): a machine-wide
  // window with JS-side filtering let 20 unrelated recent sessions evict this
  // project's history, silently yielding zero hints. The fixed-N window is
  // not fully gone — the 20-row per-project fetch still caps reach, so a
  // project whose summarized sessions all sit older than its 20 most-recent
  // (e.g. fully bare recent activity) still gets zero hints: same class as
  // #39, strictly rarer. (See #39, #209.)
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
}
