import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  type Embedder,
  MemoryStore,
  type VectorIndex,
  type VectorSummary,
  normalizeInto,
  scanContiguous,
} from '../src/index.js';
import { cosine, hybridRank, rankFromSummary } from '../src/ranker.js';

const DIM = 16;
const MODEL = 'equiv-model';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// Same text, same vector; different text, unrelated vector.
const embedder: Embedder = {
  model: MODEL,
  dim: DIM,
  async embed(text: string): Promise<Float32Array> {
    const rand = mulberry32(fnv(text));
    const v = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) v[i] = rand() * 2 - 1;
    return v;
  },
};

// Verbatim copy of MemoryStore.search at 4bb7e1f: the oracle the rewrite must match.
async function oracleSearch(store: MemoryStore, query: string, limit: number, emb: Embedder) {
  const cap = limit ?? store.settings.search.defaultLimit;
  const alpha = store.settings.search.alpha;
  const keyword = store.storage.searchFts(query, cap * 2);
  if (!emb || store.settings.embedding.provider === 'none') {
    return keyword.slice(0, cap);
  }
  const vectors = store.storage.allEmbeddings({ model: emb.model, dim: emb.dim });
  if (vectors.length === 0) return keyword.slice(0, cap);
  const qvec = await emb.embed(query);
  if (qvec.length !== emb.dim) {
    return keyword.slice(0, cap);
  }
  const scored = vectors.map((v) => ({
    id: v.observation_id,
    cosine: cosine(qvec, v.vec),
  }));
  const merged = new Map<number, { bm25?: number; cosine?: number }>();
  for (const k of keyword) merged.set(k.id, { bm25: k.score });
  for (const s of scored) {
    const cur = merged.get(s.id) ?? {};
    cur.cosine = s.cosine;
    merged.set(s.id, cur);
  }
  const ranked = hybridRank(
    Array.from(merged, ([id, v]) => ({ id, ...v })),
    alpha,
  ).slice(0, cap);
  return ranked.map((r) => ({ id: r.id, score: r.score }));
}

// Test-local VectorIndex over the same storage, proving the seam end to end.
function inlineIndex(store: MemoryStore): VectorIndex & { calls: number } {
  const index = {
    calls: 0,
    async summarize(qvec: Float32Array, keywordIds: number[], k: number): Promise<VectorSummary> {
      index.calls++;
      const rows = store.storage.allEmbeddings({ model: MODEL, dim: DIM });
      const data = new Float32Array(rows.length * DIM);
      const ids = new Float64Array(rows.length);
      rows.forEach((r, i) => {
        normalizeInto(data, i, r.vec, DIM);
        ids[i] = r.observation_id;
      });
      return {
        ...scanContiguous(data, ids, rows.length, DIM, qvec, new Set(keywordIds), k),
        queuedMs: 0,
        warmup: false,
      };
    },
  };
  return index;
}

const VOCAB = Array.from({ length: 40 }, (_, i) => `term${i}x`);

function seed(dbPath: string, size: number, seedNo: number): void {
  const rand = mulberry32(seedNo);
  const store = new MemoryStore({ dbPath, settings: defaultSettings });
  store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
  for (let i = 0; i < size; i++) {
    const words = Array.from({ length: 6 }, () => VOCAB[Math.floor(rand() * VOCAB.length)]);
    const content = words.join(' ');
    const id = store.addObservation({ session_id: 's1', kind: 'note', content });
    // ~80% embedded, so some keyword hits have no vector.
    if (rand() < 0.8) {
      const row = store.storage.getObservations([id])[0];
      // Vectors derive from stored content, as the worker does.
      store.storage.putEmbedding(id, MODEL, vecSync(row?.content ?? content));
    }
  }
  store.close();
}

function vecSync(text: string): Float32Array {
  const rand = mulberry32(fnv(text));
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = rand() * 2 - 1;
  return v;
}

function queriesFor(seedNo: number): string[] {
  const rand = mulberry32(seedNo + 1000);
  const out: string[] = [];
  for (let i = 0; i < 20; i++) {
    if (i % 5 === 4) {
      out.push(`nomatch${i}zq`); // no FTS hit: vector-only ranking
    } else {
      const n = 1 + (i % 2);
      out.push(
        Array.from({ length: n }, () => VOCAB[Math.floor(rand() * VOCAB.length)]).join(' OR '),
      );
    }
  }
  return out;
}

type Hit = { id: number; score: number };

function expectSameRanking(actual: Hit[], oracle: Hit[]): void {
  expect(actual).toHaveLength(oracle.length);
  const tol = 1e-6;
  for (let i = 0; i < oracle.length; i++) {
    const a = actual[i] as Hit;
    const o = oracle[i] as Hit;
    if (a.id === o.id) {
      expect(Math.abs(a.score - o.score)).toBeLessThan(tol);
      continue;
    }
    // Adjacent swap is allowed only when the oracle itself calls it a tie.
    const nextA = actual[i + 1];
    const nextO = oracle[i + 1];
    expect(nextA && nextO).toBeTruthy();
    expect(nextA?.id).toBe(o.id);
    expect(nextO?.id).toBe(a.id);
    expect(Math.abs(o.score - (nextO as Hit).score)).toBeLessThan(tol);
    expect(Math.abs(a.score - o.score)).toBeLessThan(tol);
    expect(Math.abs((nextA as Hit).score - (nextO as Hit).score)).toBeLessThan(tol);
    i++;
  }
}

const tmp = mkTmp();
function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'cavemem-equiv-'));
}
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function storeWithAlpha(dbPath: string, alpha: number): MemoryStore {
  return new MemoryStore({
    dbPath,
    settings: { ...defaultSettings, search: { ...defaultSettings.search, alpha } },
  });
}

describe.each([
  [50, 11],
  [500, 22],
  [3000, 33],
])('search equivalence, %i observations', (size, seedNo) => {
  const dbPath = join(tmp, `corpus-${size}.db`);
  seed(dbPath, size, seedNo);
  const queries = queriesFor(seedNo);

  for (const withIndex of [false, true]) {
    it(`matches the oracle for alpha in {0, 0.25, 0.5, 0.75}${withIndex ? ' through a VectorIndex' : ''}`, async () => {
      let hybridSeen = 0;
      for (const alpha of [0, 0.25, 0.5, 0.75]) {
        const store = storeWithAlpha(dbPath, alpha);
        const index = withIndex ? inlineIndex(store) : undefined;
        for (const q of queries) {
          for (const cap of [1, 5, 10]) {
            const oracle = await oracleSearch(store, q, cap, embedder);
            const got = await store.search(q, cap, embedder, index ? { index } : {});
            expectSameRanking(
              got.map((h) => ({ id: h.id, score: h.score })),
              oracle,
            );
            hybridSeen += got.length;
          }
        }
        store.close();
      }
      expect(hybridSeen).toBeGreaterThan(0);
    }, 120_000);
  }
});

describe('search options', () => {
  const dbPath = join(tmp, 'options.db');
  seed(dbPath, 60, 5);

  it('alpha = 1 returns keyword hits only', async () => {
    const store = storeWithAlpha(dbPath, 1);
    const index = inlineIndex(store);
    const spy = vi.spyOn(index, 'summarize');
    const embedSpy = vi.spyOn(embedder, 'embed');
    const q = VOCAB[3] as string;
    const got = await store.search(q, 5, embedder, { index });
    const expected = store.storage.searchFts(q, 10).slice(0, 5);
    expect(expected.length).toBeGreaterThan(0);
    expect(got.map((h) => h.id)).toEqual(expected.map((h) => h.id));
    expect(spy).not.toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
    embedSpy.mockRestore();
    store.close();
  });

  it('onSummary fires once per hybrid search and never for keyword-only', async () => {
    const store = storeWithAlpha(dbPath, 0.5);
    const onSummary = vi.fn();
    await store.search(VOCAB[3] as string, 5, embedder, { onSummary });
    expect(onSummary).toHaveBeenCalledTimes(1);
    expect((onSummary.mock.calls[0]?.[0] as VectorSummary).count).toBeGreaterThan(0);

    const none = vi.fn();
    const noneStore = new MemoryStore({
      dbPath,
      settings: {
        ...defaultSettings,
        embedding: { ...defaultSettings.embedding, provider: 'none' },
      },
    });
    await noneStore.search(VOCAB[3] as string, 5, embedder, { onSummary: none });
    noneStore.close();
    const alphaOne = storeWithAlpha(dbPath, 1);
    await alphaOne.search(VOCAB[3] as string, 5, embedder, { onSummary: none });
    alphaOne.close();
    expect(none).not.toHaveBeenCalled();
    store.close();
  });

  it('index errors propagate', async () => {
    const store = storeWithAlpha(dbPath, 0.5);
    const index: VectorIndex = {
      summarize: () => Promise.reject(new Error('scanner exploded')),
    };
    await expect(store.search(VOCAB[3] as string, 5, embedder, { index })).rejects.toThrow(
      'scanner exploded',
    );
    store.close();
  });

  it('skips malformed stored vectors instead of reading past them', async () => {
    const path = join(tmp, 'malformed.db');
    seed(path, 20, 9);
    const store = storeWithAlpha(path, 0.5);
    const [victim] = store.storage.allEmbeddings({ model: MODEL, dim: DIM });
    if (!victim) throw new Error('seed produced no embeddings');
    // dim column still says 16 but the BLOB holds two floats.
    (
      store.storage as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }
    ).db
      .prepare('UPDATE embeddings SET vec = ? WHERE observation_id = ?')
      .run(Buffer.alloc(8), victim.observation_id);
    const got = await store.search('nomatchzq', 100, embedder);
    expect(got.length).toBeGreaterThan(0);
    expect(got.some((h) => h.id === victim.observation_id)).toBe(false);
    for (const h of got) expect(Number.isNaN(h.score)).toBe(false);
    store.close();
  });
});

describe('rankFromSummary basis', () => {
  // Signed random vectors keep 0 inside the cosine range; these cases pin the
  // all-positive and all-negative ranges where the implicit 0 changes the scale.
  it.each([
    ['all-positive cosines', 0.2, 0.9],
    ['all-negative cosines', -0.9, -0.2],
    ['mixed cosines', -0.5, 0.7],
  ])('matches hybridRank with %s and unembedded keyword hits', (_name, lo, hi) => {
    const rand = mulberry32(99);
    for (let trial = 0; trial < 50; trial++) {
      const items: Array<{ id: number; bm25?: number; cosine?: number }> = [];
      const keyword: Array<{ id: number; score: number }> = [];
      let id = 1;
      for (let i = 0; i < 1 + Math.floor(rand() * 5); i++, id++) {
        const score = 0.5 + rand() * 3;
        keyword.push({ id, score });
        // Some keyword hits have no embedding.
        const embedded = rand() < 0.5;
        items.push({ id, bm25: score, ...(embedded ? { cosine: lo + rand() * (hi - lo) } : {}) });
      }
      const vectorOnly = Math.floor(rand() * 6);
      for (let i = 0; i < vectorOnly; i++, id++) {
        items.push({ id, cosine: lo + rand() * (hi - lo) });
      }
      const withCos = items.filter((x) => x.cosine !== undefined);
      if (withCos.length === 0) continue;
      const cos = withCos.map((x) => x.cosine as number);
      const kwSet = new Set(keyword.map((k) => k.id));
      const summary: VectorSummary = {
        count: withCos.length,
        min: Math.min(...cos),
        max: Math.max(...cos),
        keywordCosines: withCos
          .filter((x) => kwSet.has(x.id))
          .map((x) => [x.id, x.cosine as number]),
        top: withCos
          .filter((x) => !kwSet.has(x.id))
          .map((x): [number, number] => [x.id, x.cosine as number])
          .sort((a, b) => b[1] - a[1] || a[0] - b[0]),
        queuedMs: 0,
        warmup: false,
      };
      for (const alpha of [0, 0.3, 0.7]) {
        expectSameRanking(rankFromSummary(keyword, summary, alpha), hybridRank(items, alpha));
      }
    }
  });
});
