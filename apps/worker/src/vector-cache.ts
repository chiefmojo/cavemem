import { type VectorSummary, normalizeInto, scanContiguous } from '@cavemem/core';
import type { Storage } from '@cavemem/storage';

const PAGE = 10_000;
const DEFAULT_CAPACITY = 1024;

type LogFn = (line: Record<string, unknown>) => void;

const stderrLog: LogFn = (line) => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

/**
 * Normalized embeddings for one (model, dim), held in one contiguous buffer so
 * a search is a single dot-product pass. Uses only public Storage reads, so it
 * works over a read-only connection while another connection keeps writing.
 */
export class VectorCache {
  private data: Float32Array;
  private ids: Float64Array;
  private n = 0;
  private maxId = 0;
  private loads = 0;

  constructor(
    private readonly storage: Storage,
    private readonly model: string,
    private readonly dim: number,
    private readonly log: LogFn = stderrLog,
    initialCapacity: number = DEFAULT_CAPACITY,
  ) {
    const capacity = Math.max(1, initialCapacity);
    this.data = new Float32Array(capacity * dim);
    this.ids = new Float64Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  get fullLoads(): number {
    return this.loads;
  }

  load(): void {
    this.loads++;
    this.n = 0;
    this.maxId = 0;
    this.pullAboveWatermark();
    const skipped = this.storage.countEmbeddings({ model: this.model, dim: this.dim }) - this.n;
    // Rows with a blob length that disagrees with dim are filtered out by every
    // paging query, so they are reported here once rather than retried forever.
    if (skipped > 0) this.log({ event: 'vector-cache-skip', skipped });
  }

  refresh(): void {
    this.pullAboveWatermark();
    // Equal counts mean nothing sits below the watermark. The embed loop
    // backfills newest first, so a mid-batch refresh leaves gaps there.
    if (this.storage.embeddingCount(this.model, this.dim) === this.n) return;
    const cached = new Set<number>();
    for (let i = 0; i < this.n; i++) cached.add(this.ids[i] as number);
    const missing = this.storage.embeddingIds(this.model, this.dim).filter((id) => !cached.has(id));
    for (const row of this.storage.embeddingsByIds(this.model, this.dim, missing)) {
      this.add(row.observation_id, row.vec);
    }
  }

  summarize(
    qvec: Float32Array,
    keywordIds: number[],
    k: number,
  ): Omit<VectorSummary, 'queuedMs' | 'warmup'> {
    return scanContiguous(this.data, this.ids, this.n, this.dim, qvec, new Set(keywordIds), k);
  }

  private pullAboveWatermark(): void {
    for (;;) {
      const page = this.storage.embeddingsAfter(this.model, this.dim, this.maxId, PAGE);
      for (const row of page) this.add(row.observation_id, row.vec);
      if (page.length < PAGE) return;
    }
  }

  private add(id: number, vec: Float32Array): void {
    if (this.n === this.ids.length) this.grow();
    normalizeInto(this.data, this.n, vec, this.dim);
    this.ids[this.n] = id;
    this.n++;
    if (id > this.maxId) this.maxId = id;
  }

  private grow(): void {
    const capacity = this.ids.length * 2;
    const data = new Float32Array(capacity * this.dim);
    data.set(this.data);
    const ids = new Float64Array(capacity);
    ids.set(this.ids);
    this.data = data;
    this.ids = ids;
  }
}
