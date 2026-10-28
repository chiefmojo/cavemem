import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/index.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Storage', () => {
  it('stores and retrieves observations', () => {
    storage.createSession({
      id: 'sess-1',
      ide: 'claude-code',
      cwd: '/tmp',
      started_at: Date.now(),
      metadata: null,
    });
    const id = storage.insertObservation({
      session_id: 'sess-1',
      kind: 'note',
      content: 'db config updated',
      compressed: true,
      intensity: 'full',
    });
    const rows = storage.getObservations([id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.compressed).toBe(1);
  });

  it('FTS search finds matches', () => {
    storage.createSession({
      id: 's',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    storage.insertObservation({
      session_id: 's',
      kind: 'note',
      content: 'auth middleware throws 401',
      compressed: true,
      intensity: 'full',
    });
    const hits = storage.searchFts('auth');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.snippet).toContain('[auth]');
  });

  it('FTS search scopes results to cwd when provided (#39)', () => {
    storage.createSession({
      id: 'proj-A',
      ide: 'claude-code',
      cwd: '/work/A',
      started_at: Date.now(),
      metadata: null,
    });
    storage.createSession({
      id: 'proj-B',
      ide: 'claude-code',
      cwd: '/work/B',
      started_at: Date.now(),
      metadata: null,
    });
    storage.insertObservation({
      session_id: 'proj-A',
      kind: 'note',
      content: 'shared keyword in project A',
      compressed: true,
      intensity: 'full',
    });
    storage.insertObservation({
      session_id: 'proj-B',
      kind: 'note',
      content: 'shared keyword in project B',
      compressed: true,
      intensity: 'full',
    });
    expect(storage.searchFts('keyword').length).toBe(2);
    const scopedA = storage.searchFts('keyword', 10, '/work/A');
    expect(scopedA).toHaveLength(1);
    expect(scopedA[0]?.session_id).toBe('proj-A');
    const scopedB = storage.searchFts('keyword', 10, '/work/B');
    expect(scopedB).toHaveLength(1);
    expect(scopedB[0]?.session_id).toBe('proj-B');
  });

  it('listSessions({ cwd: "" }) scopes to empty-cwd sessions, not machine-wide (#209)', () => {
    // '' is a real cwd value (a session recorded with an empty working
    // directory) — it must scope by exact match, not fall through to the
    // machine-wide query. Explicit started_at keeps ORDER BY ... DESC deterministic.
    const t = Date.now();
    storage.createSession({ id: 'empty-1', ide: 'test', cwd: '', started_at: t, metadata: null });
    storage.createSession({ id: 'x-1', ide: 'test', cwd: '/x', started_at: t + 1, metadata: null });
    storage.createSession({
      id: 'empty-2',
      ide: 'test',
      cwd: '',
      started_at: t + 2,
      metadata: null,
    });

    expect(storage.listSessions(10, { cwd: '' }).map((s) => s.id)).toEqual(['empty-2', 'empty-1']);
    // undefined opts.cwd stays machine-wide — all three rows.
    expect(storage.listSessions(10)).toHaveLength(3);
  });

  it('stores and retrieves embeddings', () => {
    storage.createSession({
      id: 's2',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const id = storage.insertObservation({
      session_id: 's2',
      kind: 'note',
      content: 'x',
      compressed: true,
      intensity: 'full',
    });
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    storage.putEmbedding(id, 'test-model', vec);
    const got = storage.getEmbedding(id);
    expect(got?.dim).toBe(3);
    expect(Array.from(got?.vec)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
  });

  it('allEmbeddings filters by model + dim', () => {
    storage.createSession({
      id: 's3',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        storage.insertObservation({
          session_id: 's3',
          kind: 'note',
          content: `n${i}`,
          compressed: true,
          intensity: 'full',
        }),
      );
    }
    storage.putEmbedding(ids[0] as number, 'old-model', new Float32Array([1, 2]));
    storage.putEmbedding(ids[1] as number, 'new-model', new Float32Array([1, 2, 3]));
    storage.putEmbedding(ids[2] as number, 'new-model', new Float32Array([4, 5, 6]));

    expect(storage.allEmbeddings().length).toBe(3);
    expect(storage.allEmbeddings({ model: 'new-model', dim: 3 }).length).toBe(2);
    expect(storage.allEmbeddings({ model: 'old-model', dim: 2 }).length).toBe(1);
    expect(storage.allEmbeddings({ model: 'new-model', dim: 2 }).length).toBe(0);
  });

  it('dropEmbeddingsWhereModelNot clears stale rows', () => {
    storage.createSession({
      id: 's4',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const a = storage.insertObservation({
      session_id: 's4',
      kind: 'note',
      content: 'a',
      compressed: true,
      intensity: 'full',
    });
    const b = storage.insertObservation({
      session_id: 's4',
      kind: 'note',
      content: 'b',
      compressed: true,
      intensity: 'full',
    });
    storage.putEmbedding(a, 'old-model', new Float32Array([1]));
    storage.putEmbedding(b, 'new-model', new Float32Array([1]));

    const dropped = storage.dropEmbeddingsWhereModelNot('new-model');
    expect(dropped).toBe(1);
    expect(storage.allEmbeddings().length).toBe(1);
  });

  it('observationsMissingEmbeddings respects the model filter', () => {
    storage.createSession({
      id: 's5',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        storage.insertObservation({
          session_id: 's5',
          kind: 'note',
          content: `n${i}`,
          compressed: true,
          intensity: 'full',
        }),
      );
    }
    storage.putEmbedding(ids[0] as number, 'model-a', new Float32Array([1]));

    // No filter: only ids[0] has an embedding at all, so ids[1] and ids[2] are missing.
    expect(
      storage
        .observationsMissingEmbeddings(10)
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids[1], ids[2]].sort());
    // Filter to model-b: ids[0] has no model-b embedding, so all 3 are missing.
    expect(
      storage
        .observationsMissingEmbeddings(10, 'model-b')
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids[0], ids[1], ids[2]].sort());
  });

  it('createSession reports whether the row was inserted or already existed', () => {
    const first = storage.createSession({
      id: 'dupe',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const second = storage.createSession({
      id: 'dupe',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('importObservation inserts verbatim at an explicit id and skips exact re-imports (used by `cavemem import`)', () => {
    storage.createSession({
      id: 'sess-import',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const row = {
      id: 42,
      session_id: 'sess-import',
      kind: 'note',
      content: 'auth mw throws 401',
      compressed: 1 as const,
      intensity: 'full',
      ts: Date.now(),
      metadata: null,
    };
    expect(storage.importObservation(row)).toBe('inserted');
    // Same (session_id, ts, content) again → genuine re-import, no-op.
    expect(storage.importObservation(row)).toBe('skipped');
    const [got] = storage.getObservations([42]);
    expect(got?.content).toBe('auth mw throws 401');
    // The FTS index is kept in sync via the same INSERT trigger as any
    // other write path.
    expect(storage.searchFts('auth').map((h) => h.id)).toContain(42);
    // No embedding row is written, so the observation is eligible for the
    // worker's embedding backfill loop exactly like any freshly-added row.
    expect(storage.observationsMissingEmbeddings(10).map((o) => o.id)).toContain(42);
  });

  it('importObservation reassigns a fresh id when the exported id belongs to a different observation', () => {
    storage.createSession({
      id: 'sess-import-2',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    // Simulate machine B's own local row occupying the id.
    const localId = storage.insertObservation({
      session_id: 'sess-import-2',
      kind: 'note',
      content: 'machine B local observation',
      compressed: true,
      intensity: 'full',
    });
    // Machine A's export also has this id, but different content.
    const foreign = {
      id: localId,
      session_id: 'sess-import-2',
      kind: 'note',
      content: 'machine A observation with colliding id',
      compressed: 1 as const,
      intensity: 'full',
      ts: Date.now(),
      metadata: null,
    };
    expect(storage.importObservation(foreign)).toBe('reassigned');
    // Both observations survive; the local row is untouched.
    expect(storage.countObservations()).toBe(2);
    const [local] = storage.getObservations([localId]);
    expect(local?.content).toBe('machine B local observation');
    // Re-importing the reassigned record is still a no-op (matched by
    // content, not by its now-meaningless exported id).
    expect(storage.importObservation(foreign)).toBe('skipped');
    expect(storage.countObservations()).toBe(2);
  });

  it('transaction rolls back every write when the callback throws', () => {
    storage.createSession({
      id: 'sess-tx',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    expect(() =>
      storage.transaction(() => {
        storage.insertObservation({
          session_id: 'sess-tx',
          kind: 'note',
          content: 'should not survive',
          compressed: true,
          intensity: 'full',
        });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(storage.countObservations()).toBe(0);
  });

  it('countObservations + countEmbeddings return correct totals', () => {
    storage.createSession({
      id: 's6',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    expect(storage.countObservations()).toBe(0);
    const id = storage.insertObservation({
      session_id: 's6',
      kind: 'note',
      content: 'a',
      compressed: true,
      intensity: 'full',
    });
    expect(storage.countObservations()).toBe(1);
    expect(storage.countEmbeddings()).toBe(0);
    storage.putEmbedding(id, 'm', new Float32Array([1]));
    expect(storage.countEmbeddings()).toBe(1);
    expect(storage.countEmbeddings({ model: 'm', dim: 1 })).toBe(1);
    expect(storage.countEmbeddings({ model: 'm', dim: 2 })).toBe(0);
  });

  it('listSummaries breaks same-ts ties newest-inserted-first', () => {
    storage.createSession({
      id: 'tie-1',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const sameTs = 1_700_000_000_000;
    // The bridge's detached stop/session-end spawns can insert both summaries
    // within the same millisecond — ordering must stay deterministic (highest
    // rowid, i.e. latest insert, first) or hint selection flips between them.
    storage.insertSummary({
      session_id: 'tie-1',
      scope: 'session',
      content: 'inserted first',
      compressed: true,
      intensity: 'full',
      ts: sameTs,
    });
    storage.insertSummary({
      session_id: 'tie-1',
      scope: 'turn',
      content: 'inserted second',
      compressed: true,
      intensity: 'full',
      ts: sameTs,
    });

    expect(storage.listSummaries('tie-1').map((s) => s.content)).toEqual([
      'inserted second',
      'inserted first',
    ]);
  });

  it('summaryCoverage counts turn summaries per IDE, ignoring session scope', () => {
    storage.createSession({
      id: 'cov-a1',
      ide: 'ide-a',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    storage.createSession({
      id: 'cov-a2',
      ide: 'ide-a',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    storage.createSession({
      id: 'cov-b1',
      ide: 'ide-b',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    storage.insertSummary({
      session_id: 'cov-a1',
      scope: 'turn',
      content: 'did the thing',
      compressed: true,
      intensity: 'full',
    });
    // Session-scope rollups are a different signal — must not inflate coverage.
    storage.insertSummary({
      session_id: 'cov-b1',
      scope: 'session',
      content: 'session wrap-up',
      compressed: true,
      intensity: 'full',
    });
    // Schema declares ide NOT NULL, but an empty string still slips through —
    // it must fold into the 'unknown' bucket, not render as " 0/N".
    storage.createSession({
      id: 'cov-e1',
      ide: '',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    storage.insertSummary({
      session_id: 'cov-e1',
      scope: 'turn',
      content: 'orphan turn',
      compressed: true,
      intensity: 'full',
    });

    const coverage = storage.summaryCoverage();
    expect(coverage).toEqual([
      { ide: 'ide-a', sessions: 2, summaries: 1 },
      { ide: 'ide-b', sessions: 1, summaries: 0 },
      { ide: 'unknown', sessions: 1, summaries: 1 },
    ]);
  });
});

describe('Storage embedding paging', () => {
  function seed(n: number): number[] {
    storage.createSession({
      id: 'page',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        storage.insertObservation({
          session_id: 'page',
          kind: 'note',
          content: `obs ${i}`,
          compressed: true,
          intensity: 'full',
        }),
      );
    }
    return ids;
  }

  const vecFor = (id: number): Float32Array => new Float32Array([id, id + 1, id + 2, id + 3]);

  // putEmbedding always writes dim = vec.length, so a blob whose length
  // disagrees with dim can only come from a raw insert.
  function insertMalformed(observationId: number): void {
    const require = createRequire(import.meta.url);
    const emit = process.emitWarning;
    process.emitWarning = () => {};
    let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite'));
    } finally {
      process.emitWarning = emit;
    }
    const raw = new DatabaseSync(join(dir, 'test.db'));
    try {
      raw
        .prepare('INSERT INTO embeddings(observation_id, model, dim, vec) VALUES (?, ?, ?, ?)')
        .run(observationId, 'A', 4, new Uint8Array(12));
    } finally {
      raw.close();
    }
  }

  it('embeddingsAfter pages in ascending id and respects model/dim', () => {
    const ids = seed(28);
    for (const id of ids.slice(0, 25)) storage.putEmbedding(id, 'A', vecFor(id));
    for (const id of ids.slice(25)) storage.putEmbedding(id, 'B', vecFor(id));
    const rows = storage.embeddingsAfter('A', 4, 10, 5);
    expect(rows.map((r) => r.observation_id)).toEqual([11, 12, 13, 14, 15]);
    expect(Array.from(rows[0]?.vec ?? [])).toEqual(Array.from(vecFor(11)));
    expect(storage.embeddingsAfter('A', 4, 0, 100)).toHaveLength(25);
    expect(storage.embeddingsAfter('A', 3, 0, 100)).toHaveLength(0);
  });

  it('embeddingCount counts only the given model/dim', () => {
    const ids = seed(5);
    for (const id of ids.slice(0, 3)) storage.putEmbedding(id, 'A', vecFor(id));
    for (const id of ids.slice(3)) storage.putEmbedding(id, 'B', vecFor(id));
    expect(storage.embeddingCount('A', 4)).toBe(3);
    expect(storage.embeddingCount('B', 4)).toBe(2);
    expect(storage.embeddingCount('A', 8)).toBe(0);
  });

  it('embeddingIds returns ascending ids for model/dim only', () => {
    const ids = seed(6);
    for (const id of [ids[4], ids[0], ids[2]] as number[])
      storage.putEmbedding(id, 'A', vecFor(id));
    storage.putEmbedding(ids[1] as number, 'B', vecFor(2));
    expect(storage.embeddingIds('A', 4)).toEqual([ids[0], ids[2], ids[4]]);
  });

  it('embeddingsByIds returns only requested ids that exist', () => {
    const ids = seed(3);
    for (const id of ids) storage.putEmbedding(id, 'A', vecFor(id));
    const rows = storage.embeddingsByIds('A', 4, [2, 999]);
    expect(rows.map((r) => r.observation_id)).toEqual([2]);
    expect(storage.embeddingsByIds('A', 4, [])).toEqual([]);
  });

  it('embeddingsByIds chunks id lists longer than one statement', () => {
    const ids = seed(1200);
    storage.transaction(() => {
      for (const id of ids) storage.putEmbedding(id, 'A', vecFor(id));
    });
    const rows = storage.embeddingsByIds('A', 4, ids);
    expect(rows).toHaveLength(1200);
    expect(rows.map((r) => r.observation_id)).toEqual(ids);
  });

  it('vec is a copy, not a view', () => {
    const ids = seed(1);
    storage.putEmbedding(ids[0] as number, 'A', vecFor(1));
    const first = storage.embeddingsAfter('A', 4, 0, 10);
    (first[0]?.vec as Float32Array).fill(-1);
    const second = storage.embeddingsAfter('A', 4, 0, 10);
    expect(Array.from(second[0]?.vec ?? [])).toEqual(Array.from(vecFor(1)));
    const byId = storage.embeddingsByIds('A', 4, [ids[0] as number]);
    expect(Array.from(byId[0]?.vec ?? [])).toEqual(Array.from(vecFor(1)));
  });

  it('malformed blobs are excluded from all four queries consistently', () => {
    const ids = seed(3);
    storage.putEmbedding(ids[0] as number, 'A', vecFor(1));
    storage.putEmbedding(ids[1] as number, 'A', vecFor(2));
    insertMalformed(ids[2] as number);
    const bad = ids[2] as number;
    expect(storage.embeddingsAfter('A', 4, 0, 100).map((r) => r.observation_id)).not.toContain(bad);
    expect(storage.embeddingIds('A', 4)).toEqual([ids[0], ids[1]]);
    expect(storage.embeddingsByIds('A', 4, ids).map((r) => r.observation_id)).toEqual([
      ids[0],
      ids[1],
    ]);
    expect(storage.embeddingCount('A', 4)).toBe(2);
    expect(storage.countEmbeddings({ model: 'A', dim: 4 })).toBe(3);
  });
});
