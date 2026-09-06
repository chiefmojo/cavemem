import type { MemoryStore } from '@cavemem/core';
import type { HookInput } from '../types.js';

// Cap on how many of the most-recent same-cwd sessions the hint scan walks
// past before giving up — bounds how stale injected context can get when the
// recent sessions carry no summaries.
const MAX_CANDIDATES_SCANNED = 10;

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
  // #39, strictly rarer. Within the window, at most MAX_CANDIDATES_SCANNED
  // most-recent sessions are scanned so injected context can't reach
  // arbitrarily far back, and summary-less candidates are skipped before the
  // 3-hint cap so newer bare sessions can't crowd out a summarized one.
  // (See #39, #209.)
  const recent = store.storage.listSessions(20, { cwd: input.cwd ?? null });
  const hints: string[] = [];
  let scanned = 0;
  for (const s of recent) {
    if (s.id === input.session_id) continue;
    if (scanned >= MAX_CANDIDATES_SCANNED) break;
    scanned++;
    const summary = store.storage.listSummaries(s.id)[0];
    if (!summary) continue;
    hints.push(summary.content);
    if (hints.length === 3) break;
  }
  if (hints.length === 0) return '';
  return `## Prior-session context\n${hints.join('\n---\n')}`;
}
