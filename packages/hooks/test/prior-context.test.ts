import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
