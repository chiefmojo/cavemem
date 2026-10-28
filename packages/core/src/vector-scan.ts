export interface VectorSummary {
  /** Embedded vectors scanned. */
  count: number;
  /** Global min cosine over all `count` vectors (0 when count = 0). */
  min: number;
  /** Global max cosine over all `count` vectors (0 when count = 0). */
  max: number;
  /** Only keyword ids that have an embedding. */
  keywordCosines: Array<[id: number, cosine: number]>;
  /** Top k non-keyword ids, cosine desc then id asc. */
  top: Array<[id: number, cosine: number]>;
  /** Time the request waited for a free scanner; 0 in-process. */
  queuedMs: number;
  /** True when the scanner had to load its corpus first; false in-process. */
  warmup: boolean;
}

export interface VectorIndex {
  summarize(qvec: Float32Array, keywordIds: number[], k: number): Promise<VectorSummary>;
}

/**
 * Writes `src / ||src||` into `dst` at row `offset`. A zero or non-finite norm
 * writes zeros so the row scores cosine 0 instead of NaN. Reads exactly `dim`
 * elements of `src`; callers must reject shorter vectors first.
 */
export function normalizeInto(
  dst: Float32Array,
  offset: number,
  src: Float32Array,
  dim: number,
): void {
  const base = offset * dim;
  let sq = 0;
  for (let i = 0; i < dim; i++) {
    const x = src[i] as number;
    sq += x * x;
  }
  const norm = Math.sqrt(sq);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    dst.fill(0, base, base + dim);
    return;
  }
  for (let i = 0; i < dim; i++) dst[base + i] = (src[i] as number) / norm;
}

// Weakest candidate sits at the root: lowest cosine, and on a tie the higher
// id, so the lower id survives at the cutoff.
function weaker(cosA: number, idA: number, cosB: number, idB: number): boolean {
  return cosA < cosB || (cosA === cosB && idA > idB);
}

/**
 * One dot-product pass over `n` pre-normalized rows. `data` rows must come from
 * `normalizeInto`, so a dot product is the cosine.
 */
export function scanContiguous(
  data: Float32Array,
  ids: Float64Array,
  n: number,
  dim: number,
  qvec: Float32Array,
  keywordIds: ReadonlySet<number>,
  k: number,
): Omit<VectorSummary, 'queuedMs' | 'warmup'> {
  if (n === 0) return { count: 0, min: 0, max: 0, keywordCosines: [], top: [] };

  const q = new Float32Array(dim);
  normalizeInto(q, 0, qvec, dim);

  const cap = Math.max(0, Math.min(k, n));
  const heapCos = new Float64Array(cap);
  const heapId = new Float64Array(cap);
  let size = 0;

  const siftDown = (start: number): void => {
    let i = start;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let w = i;
      if (
        l < size &&
        weaker(heapCos[l] as number, heapId[l] as number, heapCos[w] as number, heapId[w] as number)
      )
        w = l;
      if (
        r < size &&
        weaker(heapCos[r] as number, heapId[r] as number, heapCos[w] as number, heapId[w] as number)
      )
        w = r;
      if (w === i) return;
      const c = heapCos[i] as number;
      const d = heapId[i] as number;
      heapCos[i] = heapCos[w] as number;
      heapId[i] = heapId[w] as number;
      heapCos[w] = c;
      heapId[w] = d;
      i = w;
    }
  };

  const siftUp = (start: number): void => {
    let i = start;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (
        !weaker(
          heapCos[i] as number,
          heapId[i] as number,
          heapCos[p] as number,
          heapId[p] as number,
        )
      )
        return;
      const c = heapCos[i] as number;
      const d = heapId[i] as number;
      heapCos[i] = heapCos[p] as number;
      heapId[i] = heapId[p] as number;
      heapCos[p] = c;
      heapId[p] = d;
      i = p;
    }
  };

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const keywordCosines: Array<[number, number]> = [];

  for (let row = 0; row < n; row++) {
    const base = row * dim;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += (data[base + i] as number) * (q[i] as number);
    const id = ids[row] as number;
    if (dot < min) min = dot;
    if (dot > max) max = dot;
    if (keywordIds.has(id)) {
      keywordCosines.push([id, dot]);
      continue;
    }
    if (cap === 0) continue;
    if (size < cap) {
      heapCos[size] = dot;
      heapId[size] = id;
      size++;
      siftUp(size - 1);
    } else if (weaker(heapCos[0] as number, heapId[0] as number, dot, id)) {
      heapCos[0] = dot;
      heapId[0] = id;
      siftDown(0);
    }
  }

  const top: Array<[number, number]> = [];
  for (let i = 0; i < size; i++) top.push([heapId[i] as number, heapCos[i] as number]);
  top.sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  return { count: n, min, max, keywordCosines, top };
}
