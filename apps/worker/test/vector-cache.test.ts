import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeInto, scanContiguous } from '@cavemem/core';
import { Storage } from '@cavemem/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VectorCache } from '../src/vector-cache.js';

const MODEL = 'm';
const DIM = 4;

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-vcache-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

// Deterministic, id-dependent and never all-zero.
function vecFor(id: number): Float32Array {
  return new Float32Array([Math.sin(id) + 2, Math.cos(id * 3), Math.sin(id * 7), (id % 5) + 1]);
}

function addObservations(n: number): number[] {
  storage.createSession({
    id: 's',
    ide: 'claude-code',
    cwd: null,
    started_at: Date.now(),
    metadata: null,
  });
  const ids: number[] = [];
  storage.transaction(() => {
    for (let i = 0; i < n; i++) {
      ids.push(
        storage.insertObservation({
          session_id: 's',
          kind: 'note',
          content: `obs ${i}`,
          compressed: true,
          intensity: 'full',
        }),
      );
    }
  });
  return ids;
}

function embed(ids: number[]): void {
  storage.transaction(() => {
    for (const id of ids) storage.putEmbedding(id, MODEL, vecFor(id));
  });
}

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
      .run(observationId, MODEL, DIM, new Uint8Array(12));
  } finally {
    raw.close();
  }
}

describe('VectorCache', () => {
  it('load then summarize matches scanContiguous over the same rows', () => {
    const ids = addObservations(30);
    embed(ids);
    const cache = new VectorCache(storage, MODEL, DIM);
    cache.load();
    expect(cache.size).toBe(30);

    const data = new Float32Array(ids.length * DIM);
    const idArr = new Float64Array(ids.length);
    ids.forEach((id, row) => {
      normalizeInto(data, row, vecFor(id), DIM);
      idArr[row] = id;
    });
    const q = new Float32Array([1, 0.5, -0.25, 2]);
    const keyword = [3, 4, 999];
    const expected = scanContiguous(data, idArr, ids.length, DIM, q, new Set(keyword), 7);
    expect(cache.summarize(q, keyword, 7)).toEqual(expected);
  });

  it('refresh picks up rows above the watermark', () => {
    const ids = addObservations(10);
    embed(ids.slice(0, 5));
    const cache = new VectorCache(storage, MODEL, DIM);
    cache.load();
    expect(cache.size).toBe(5);
    embed(ids.slice(5));
    cache.refresh();
    expect(cache.size).toBe(10);
    expect(cache.fullLoads).toBe(1);
  });

  it('refresh fills 1000 ids below the watermark without a full reload', () => {
    const ids = addObservations(2000);
    embed(ids.filter((id) => id % 2 === 0));
    const cache = new VectorCache(storage, MODEL, DIM);
    cache.load();
    expect(cache.size).toBe(1000);
    embed(ids.filter((id) => id % 2 === 1));
    cache.refresh();
    expect(cache.size).toBe(2000);
    expect(cache.fullLoads).toBe(1);

    // Gap-filled rows must be indistinguishable from a cold full load.
    const fresh = new VectorCache(storage, MODEL, DIM);
    fresh.load();
    const q = new Float32Array([0.3, -1, 0.7, 2]);
    // keywordCosines follow row order, which differs after a gap fill.
    const byId = (s: ReturnType<VectorCache['summarize']>) => ({
      ...s,
      keywordCosines: [...s.keywordCosines].sort((a, b) => a[0] - b[0]),
    });
    expect(byId(cache.summarize(q, [7, 1500], 25))).toEqual(
      byId(fresh.summarize(q, [7, 1500], 25)),
    );
  });

  it('mid-batch case: ids written below the watermark are all present', () => {
    addObservations(100);
    embed([100]);
    const cache = new VectorCache(storage, MODEL, DIM);
    cache.load();
    embed([99, 98]);
    cache.refresh();
    expect(cache.size).toBe(3);
    const found = cache.summarize(vecFor(1), [], 10).top.map(([id]) => id);
    expect(found.sort((a, b) => a - b)).toEqual([98, 99, 100]);
    expect(cache.fullLoads).toBe(1);
  });

  it('rows whose blob length mismatches dim are skipped and logged', () => {
    const ids = addObservations(4);
    embed(ids.slice(0, 3));
    insertMalformed(ids[3] as number);
    const log = vi.fn();
    const cache = new VectorCache(storage, MODEL, DIM, log);
    cache.load();
    expect(cache.size).toBe(3);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ event: 'vector-cache-skip', skipped: 1 });
    expect(cache.summarize(vecFor(1), [], 10).count).toBe(3);

    const idsSpy = vi.spyOn(storage, 'embeddingIds');
    cache.refresh();
    expect(idsSpy).not.toHaveBeenCalled();
    expect(cache.size).toBe(3);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('buffer grows past initial capacity', () => {
    const ids = addObservations(100);
    embed(ids);
    const cache = new VectorCache(storage, MODEL, DIM, undefined, 4);
    cache.load();
    expect(cache.size).toBe(100);
    const found = cache.summarize(vecFor(1), [], 100);
    expect(found.count).toBe(100);
    expect(found.top.map(([id]) => id).sort((a, b) => a - b)).toEqual(ids);
  });
});
