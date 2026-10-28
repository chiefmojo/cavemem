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
  /** Listed ids whose blob embeddingsByIds did not return: malformed rows. */
  private readonly rejected = new Set<number>();

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
    this.rejected.clear();
    // Sized once up front so a large load neither copies the buffer at every
    // growth step nor ends with far more capacity than rows.
    const count = this.count();
    if (count > this.ids.length) this.resize(Math.ceil(count * 1.1) + 1024);
    this.pullAboveWatermark();
    this.fillGaps();
  }

  refresh(): void {
    this.pullAboveWatermark();
    // Equal counts mean every listed row is cached or known malformed. The
    // embed loop backfills newest first, so a mid-batch refresh leaves gaps
    // below the watermark.
    if (this.count() === this.n + this.rejected.size) return;
    this.fillGaps();
  }

  summarize(
    qvec: Float32Array,
    keywordIds: number[],
    k: number,
  ): Omit<VectorSummary, 'queuedMs' | 'warmup'> {
    return scanContiguous(this.data, this.ids, this.n, this.dim, qvec, new Set(keywordIds), k);
  }

  private count(): number {
    return this.storage.countEmbeddings({ model: this.model, dim: this.dim });
  }

  private pullAboveWatermark(): void {
    for (;;) {
      const page = this.storage.embeddingsAfter(this.model, this.dim, this.maxId, PAGE);
      for (const row of page) this.add(row.observation_id, row.vec);
      if (page.length < PAGE) return;
    }
  }

  private fillGaps(): void {
    const cached = new Set<number>();
    for (let i = 0; i < this.n; i++) cached.add(this.ids[i] as number);
    const missing = this.storage
      .embeddingIds(this.model, this.dim)
      .filter((id) => !cached.has(id) && !this.rejected.has(id));
    if (missing.length === 0) return;
    const returned = new Set<number>();
    for (const row of this.storage.embeddingsByIds(this.model, this.dim, missing)) {
      this.add(row.observation_id, row.vec);
      returned.add(row.observation_id);
    }
    // Rows are never deleted while the thread runs, so a requested id that did
    // not come back failed the blob length check. Only requested ids qualify: a
    // row written after the id list was taken is simply picked up next time.
    let skipped = 0;
    for (const id of missing) {
      if (returned.has(id)) continue;
      this.rejected.add(id);
      skipped++;
    }
    if (skipped > 0) this.log({ event: 'vector-cache-skip', skipped });
  }

  private add(id: number, vec: Float32Array): void {
    if (this.n === this.ids.length) this.grow();
    normalizeInto(this.data, this.n, vec, this.dim);
    this.ids[this.n] = id;
    this.n++;
    if (id > this.maxId) this.maxId = id;
  }

  private grow(): void {
    const capacity = this.ids.length;
    this.resize(Math.max(Math.ceil(capacity * 1.5), capacity + 1));
  }

  private resize(capacity: number): void {
    const data = new Float32Array(capacity * this.dim);
    data.set(this.data.subarray(0, this.n * this.dim));
    const ids = new Float64Array(capacity);
    ids.set(this.ids.subarray(0, this.n));
    this.data = data;
    this.ids = ids;
  }
}
