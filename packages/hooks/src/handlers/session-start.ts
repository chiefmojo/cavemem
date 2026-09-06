import type { MemoryStore } from '@cavemem/core';
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
  // project's history, silently yielding zero hints. Headroom is still 20
  // within the project, and summary-less candidates are skipped before the
  // 3-hint cap so newer bare sessions can't crowd out a summarized one.
  // (See #39.)
  const recent = store.storage.listSessions(20, { cwd: input.cwd ?? null });
  const hints: string[] = [];
  for (const s of recent) {
    if (s.id === input.session_id) continue;
    const summary = store.storage.listSummaries(s.id)[0];
    if (!summary) continue;
    hints.push(summary.content);
    if (hints.length === 3) break;
  }
  if (hints.length === 0) return '';
  return `## Prior-session context\n${hints.join('\n---\n')}`;
}
