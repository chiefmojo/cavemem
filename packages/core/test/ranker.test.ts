import { describe, expect, it } from 'vitest';
import { hybridRank } from '../src/ranker.js';

describe('hybridRank', () => {
  it('returns sorted results', () => {
    const ranked = hybridRank(
      [
        { id: 1, bm25: 0.1, cosine: 0.9 },
        { id: 2, bm25: 0.9, cosine: 0.1 },
        { id: 3, bm25: 0.5, cosine: 0.5 },
      ],
      0.5,
    );
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(ranked[1]?.score ?? 0);
  });
  it('alpha=1 prefers keyword', () => {
    const ranked = hybridRank(
      [
        { id: 1, bm25: 0.1, cosine: 0.9 },
        { id: 2, bm25: 0.9, cosine: 0.1 },
      ],
      1,
    );
    expect(ranked[0]?.id).toBe(2);
  });
  it('alpha=0 prefers vector', () => {
    const ranked = hybridRank(
      [
        { id: 1, bm25: 0.1, cosine: 0.9 },
        { id: 2, bm25: 0.9, cosine: 0.1 },
      ],
      0,
    );
    expect(ranked[0]?.id).toBe(1);
  });
  it('ranks a corpus larger than the engine argument limit', () => {
    // Math.min(...xs) throws RangeError past ~125k args; the server's corpus is already larger.
    const n = 200_000;
    const items = Array.from({ length: n }, (_, i) => ({ id: i, cosine: i / n }));
    const ranked = hybridRank(items, 0.5);
    expect(ranked).toHaveLength(n);
    expect(ranked[0]?.id).toBe(n - 1);
  });
  it('scores are normalized to [0, 1]', () => {
    const ranked = hybridRank(
      [
        { id: 1, bm25: 5, cosine: 0.2 },
        { id: 2, bm25: 1, cosine: 0.8 },
      ],
      0.5,
    );
    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});
