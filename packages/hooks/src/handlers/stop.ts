import type { MemoryStore } from '@cavemem/core';
import type { HookInput } from '../types.js';

export async function stop(store: MemoryStore, input: HookInput): Promise<void> {
  const summary = input.turn_summary ?? input.last_assistant_message;
  if (!summary || !summary.trim()) {
    // A stale bridge plugin (e.g. a hand-written OpenCode one) drops
    // turn_summary; without this line the capture gap is invisible.
    if (store.settings.logLevel === 'debug') {
      process.stderr.write(
        `${JSON.stringify({ hook: 'stop', dropped: 'missing-summary', session_id: input.session_id })}\n`,
      );
    }
    return;
  }
  store.addSummary({
    session_id: input.session_id,
    scope: 'turn',
    content: summary,
  });
}
