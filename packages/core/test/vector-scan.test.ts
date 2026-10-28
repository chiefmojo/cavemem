import { describe, expect, it } from 'vitest';
import { cosine } from '../src/ranker.js';
import { normalizeInto, scanContiguous } from '../src/vector-scan.js';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(vectors: Float32Array[], ids: number[], dim: number) {
  const data = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => normalizeInto(data, i, v, dim));
  return { data, ids: Float64Array.from(ids) };
}

function randomVec(rand: () => number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rand() * 2 - 1;
  return v;
}

describe('scanContiguous', () => {
  it('matches cosine() for every row', () => {
    const rand = mulberry32(7);
    const dim = 8;
    const vectors = Array.from({ length: 200 }, () => randomVec(rand, dim));
    const ids = vectors.map((_, i) => i + 1);
    const { data, ids: idArr } = build(vectors, ids, dim);
    const q = randomVec(rand, dim);
    const kw = new Set([3, 50, 199]);
    const res = scanContiguous(data, idArr, 200, dim, q, kw, 200);

    const oracle = new Map(ids.map((id, i) => [id, cosine(q, vectors[i] as Float32Array)]));
    expect(res.count).toBe(200);
    expect(res.keywordCosines.map(([id]) => id).sort((a, b) => a - b)).toEqual([3, 50, 199]);
    for (const [id, c] of [...res.keywordCosines, ...res.top]) {
      expect(Math.abs(c - (oracle.get(id) as number))).toBeLessThan(1e-6);
    }
    const all = [...oracle.values()];
    expect(Math.abs(res.min - Math.min(...all))).toBeLessThan(1e-6);
    expect(Math.abs(res.max - Math.max(...all))).toBeLessThan(1e-6);
  });

  it('top excludes keyword ids and is ordered cosine desc then id asc', () => {
    const dim = 4;
    const same = new Float32Array([1, 0, 0, 0]);
    const other = new Float32Array([0, 1, 0, 0]);
    // ids 5, 2, 9 share a vector, so their cosines tie exactly.
    const { data, ids } = build([same, same, same, other, same], [5, 2, 9, 7, 1], dim);
    const res = scanContiguous(data, ids, 5, dim, same, new Set([1]), 10);
    expect(res.top.map(([id]) => id)).toEqual([2, 5, 9, 7]);
    expect(res.top.some(([id]) => id === 1)).toBe(false);
  });

  it('keeps the lower id when cosines tie at the cutoff', () => {
    const dim = 2;
    const v = new Float32Array([1, 0]);
    const { data, ids } = build([v, v, v, v], [8, 3, 6, 1], dim);
    const res = scanContiguous(data, ids, 4, dim, v, new Set(), 2);
    expect(res.top.map(([id]) => id)).toEqual([1, 3]);
  });

  it('keywordCosines covers only embedded keyword ids', () => {
    const dim = 4;
    const rand = mulberry32(3);
    const vectors = [randomVec(rand, dim), randomVec(rand, dim)];
    const { data, ids } = build(vectors, [1, 2], dim);
    const q = randomVec(rand, dim);
    const res = scanContiguous(data, ids, 2, dim, q, new Set([1, 9999]), 5);
    expect(res.keywordCosines).toHaveLength(1);
    const [id, c] = res.keywordCosines[0] as [number, number];
    expect(id).toBe(1);
    expect(Math.abs(c - cosine(q, vectors[0] as Float32Array))).toBeLessThan(1e-6);
  });

  it('zero-norm stored or query vector yields cosine 0, never NaN', () => {
    const dim = 4;
    const zero = new Float32Array(dim);
    const live = new Float32Array([1, 2, 3, 4]);
    const { data, ids } = build([zero, live], [1, 2], dim);

    const withZeroRow = scanContiguous(data, ids, 2, dim, live, new Set([1]), 5);
    expect(withZeroRow.keywordCosines).toEqual([[1, 0]]);

    const zeroQuery = scanContiguous(data, ids, 2, dim, zero, new Set([2]), 5);
    expect(zeroQuery.min).toBe(0);
    expect(zeroQuery.max).toBe(0);
    for (const s of [withZeroRow, zeroQuery]) {
      const nums = [s.min, s.max, ...s.keywordCosines.map((x) => x[1]), ...s.top.map((x) => x[1])];
      for (const x of nums) expect(Number.isNaN(x)).toBe(false);
    }
  });

  it('non-finite stored values are zeroed rather than poisoning the scan', () => {
    const dim = 3;
    const bad = new Float32Array([Number.NaN, 1, 1]);
    const { data, ids } = build([bad], [1], dim);
    const res = scanContiguous(data, ids, 1, dim, new Float32Array([1, 1, 1]), new Set(), 5);
    expect(res.top).toEqual([[1, 0]]);
  });

  it('k larger than the corpus returns every row once', () => {
    const dim = 4;
    const rand = mulberry32(11);
    const vectors = [1, 2, 3].map(() => randomVec(rand, dim));
    const { data, ids } = build(vectors, [4, 5, 6], dim);
    const res = scanContiguous(data, ids, 3, dim, randomVec(rand, dim), new Set(), 10);
    expect(res.top).toHaveLength(3);
    expect(new Set(res.top.map(([id]) => id)).size).toBe(3);
  });

  it('count 0 summary', () => {
    const res = scanContiguous(
      new Float32Array(0),
      new Float64Array(0),
      0,
      4,
      new Float32Array(4),
      new Set(),
      5,
    );
    expect(res).toEqual({ count: 0, min: 0, max: 0, keywordCosines: [], top: [] });
  });
});
