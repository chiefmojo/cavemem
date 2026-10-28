import type { VectorSummary } from './vector-scan.js';

export interface RankItem {
  id: number;
  bm25?: number;
  cosine?: number;
}

// A loop, not Math.min(...xs): spreading throws RangeError past ~125k arguments,
// and the cosine list has one entry per embedded observation.
function minMax(xs: number[]): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return [min, max];
}

/**
 * Normalize BM25 and cosine scores into [0, 1], then blend using alpha.
 * alpha=1 → pure keyword, alpha=0 → pure vector.
 */
export function hybridRank(items: RankItem[], alpha: number): Array<{ id: number; score: number }> {
  const bm25s = items.map((x) => x.bm25 ?? 0);
  const cosines = items.map((x) => x.cosine ?? 0);
  const [bmin, bmax] = minMax(bm25s);
  const [cmin, cmax] = minMax(cosines);
  const bRange = bmax - bmin || 1;
  const cRange = cmax - cmin || 1;

  return items
    .map((x) => {
      const b = ((x.bm25 ?? bmin) - bmin) / bRange;
      const c = ((x.cosine ?? cmin) - cmin) / cRange;
      return { id: x.id, score: alpha * b + (1 - alpha) * c };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Same scores and order as `hybridRank` over the merged keyword + vector set,
 * without materializing it: the vector-only tail is represented by the summary's
 * global cosine range and its top-k.
 */
export function rankFromSummary(
  keyword: Array<{ id: number; score: number }>,
  summary: VectorSummary,
  alpha: number,
): Array<{ id: number; score: number }> {
  const cosineById = new Map(summary.keywordCosines);
  const hasVectorOnly = summary.count - summary.keywordCosines.length > 0;

  // hybridRank treats a missing bm25/cosine as 0 when taking min/max, so the
  // basis must include 0 whenever such an item exists in the merged set.
  let [bmin, bmax] = minMax(keyword.map((k) => k.score));
  if (hasVectorOnly || keyword.length === 0) {
    if (0 < bmin) bmin = 0;
    if (0 > bmax) bmax = 0;
  }
  let cmin = summary.min;
  let cmax = summary.max;
  if (keyword.some((k) => !cosineById.has(k.id))) {
    if (0 < cmin) cmin = 0;
    if (0 > cmax) cmax = 0;
  }
  const bRange = bmax - bmin || 1;
  const cRange = cmax - cmin || 1;

  const scored = keyword.map((k) => {
    const b = (k.score - bmin) / bRange;
    const c = ((cosineById.get(k.id) ?? cmin) - cmin) / cRange;
    return { id: k.id, score: alpha * b + (1 - alpha) * c };
  });
  for (const [id, cos] of summary.top) {
    // A vector-only item has no bm25, which normalizes to 0.
    const c = (cos - cmin) / cRange;
    scored.push({ id, score: (1 - alpha) * c });
  }
  // Array#sort is stable: ties keep keyword-first, then top's order.
  return scored.sort((a, b) => b.score - a.score);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
