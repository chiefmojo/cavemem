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
}

export function buildPriorContext(
  store: MemoryStore,
  opts: BuildPriorContextOptions,
): PriorContextHint[] {
  const recent = store.storage.listSessions(20, { cwd: opts.cwd });
  const hints: PriorContextHint[] = [];
  let scanned = 0;
  for (const s of recent) {
    // Unconditional (no truthy guard): sessionStart historically compared
    // `s.id === input.session_id` directly, so an empty-string id is a valid
    // exclusion target. `s.id === undefined` is always false when the option
    // is absent.
    if (s.id === opts.excludeSessionId) continue;
    if (scanned >= MAX_CANDIDATES_SCANNED) break;
    scanned++;
    if (opts.endedOnly && s.ended_at === null) continue;
    const summary = store.storage.listSummaries(s.id)[0];
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
