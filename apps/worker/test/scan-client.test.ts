import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '@cavemem/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanClient, type ScanClientOptions } from '../src/scan-client.js';
import { VectorCache } from '../src/vector-cache.js';
import { scanThreadFromSource } from './support/scan-thread.js';

const MODEL = 'm';
const DIM = 4;

let dir: string;
let dbPath: string;
let storage: Storage;
let clients: ScanClient[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-scan-'));
  dbPath = join(dir, 'test.db');
  storage = new Storage(dbPath);
  clients = [];
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function vecFor(id: number): Float32Array {
  return new Float32Array([Math.sin(id) + 2, Math.cos(id * 3), Math.sin(id * 7), (id % 5) + 1]);
}

function addEmbedded(n: number): number[] {
  if (!storage.getSession('s')) {
    storage.createSession({
      id: 's',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
  }
  const ids: number[] = [];
  storage.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = storage.insertObservation({
        session_id: 's',
        kind: 'note',
        content: `obs ${i}`,
        compressed: true,
        intensity: 'full',
      });
      storage.putEmbedding(id, MODEL, vecFor(id));
      ids.push(id);
    }
  });
  return ids;
}

function makeClient(extra: Partial<ScanClientOptions> = {}): ScanClient {
  const client = new ScanClient({
    dbPath,
    model: MODEL,
    dim: DIM,
    ...scanThreadFromSource,
    log: () => {},
    ...extra,
  });
  clients.push(client);
  return client;
}

const Q = new Float32Array([1, 0.5, -0.25, 2]);

describe('ScanClient', () => {
  it('summarize before ready waits and reports warmup true', async () => {
    addEmbedded(5);
    const client = makeClient();
    const first = await client.summarize(Q, [], 3);
    expect(first.warmup).toBe(true);
    expect(first.count).toBe(5);
    const second = await client.summarize(Q, [], 3);
    expect(second.warmup).toBe(false);
  });

  it('matches in-process scanContiguous', async () => {
    const ids = addEmbedded(40);
    const keyword = [ids[2] as number, ids[9] as number, 99_999];
    const cache = new VectorCache(storage, MODEL, DIM);
    cache.load();
    const expected = cache.summarize(Q, keyword, 8);

    const got = await makeClient().summarize(Q, keyword, 8);
    expect(got.count).toBe(expected.count);
    expect(got.min).toBeCloseTo(expected.min, 6);
    expect(got.max).toBeCloseTo(expected.max, 6);
    expect(got.top.map(([id]) => id)).toEqual(expected.top.map(([id]) => id));
    got.top.forEach(([, cos], i) => expect(cos).toBeCloseTo(expected.top[i]?.[1] as number, 6));
    const byId = (rows: Array<[number, number]>) => [...rows].sort((a, b) => a[0] - b[0]);
    const g = byId(got.keywordCosines);
    const e = byId(expected.keywordCosines);
    expect(g.map(([id]) => id)).toEqual(e.map(([id]) => id));
    g.forEach(([, cos], i) => expect(cos).toBeCloseTo(e[i]?.[1] as number, 6));
  });

  it('sees rows written after start', async () => {
    addEmbedded(5);
    const client = makeClient();
    client.start();
    expect((await client.summarize(Q, [], 50)).count).toBe(5);
    const more = addEmbedded(3);
    const after = await client.summarize(Q, [], 50);
    expect(after.count).toBe(8);
    expect(after.top.map(([id]) => id)).toEqual(expect.arrayContaining(more));
  });

  it('concurrent calls are serialized and queuedMs reflects the wait', async () => {
    addEmbedded(5);
    const client = makeClient({ testDelayMs: 10 });
    await client.summarize(Q, [], 3);
    const [a, b, c] = await Promise.all([
      client.summarize(Q, [], 3),
      client.summarize(Q, [], 3),
      client.summarize(Q, [], 3),
    ]);
    expect(a.queuedMs).toBe(0);
    expect(b.queuedMs).toBeGreaterThan(0);
    expect(c.queuedMs).toBeGreaterThan(b.queuedMs);
    expect([a, b, c].every((s) => !s.warmup)).toBe(true);
  });

  it('thread exit rejects queued requests and the next call respawns', async () => {
    addEmbedded(5);
    const log = vi.fn();
    const client = makeClient({ testDelayMs: 200, log });
    client.start();
    const first = client.summarize(Q, [], 3);
    const second = client.summarize(Q, [], 3);
    const rejections = Promise.allSettled([first, second]);
    await client.thread?.terminate();
    const settled = await rejections;
    for (const s of settled) {
      expect(s.status).toBe('rejected');
      expect((s as PromiseRejectedResult).reason.message).toContain('scan thread');
    }
    expect(client.thread).toBeUndefined();

    const third = await client.summarize(Q, [], 3);
    expect(third.warmup).toBe(true);
    expect(third.count).toBe(5);
    const exits = log.mock.calls.filter(([l]) => l.event === 'scan-thread-exit');
    expect(exits).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('timeout rejects, terminates and respawns', async () => {
    addEmbedded(5);
    const log = vi.fn();
    const slow = makeClient({ timeoutMs: 50, testDelayMs: 200, log });
    const pending = slow.summarize(Q, [], 3);
    const queued = slow.summarize(Q, [], 3);
    const results = Promise.allSettled([pending, queued]);
    const settled = await results;
    expect((settled[0] as PromiseRejectedResult).reason.message).toBe(
      'scan thread timed out after 50 ms',
    );
    expect(settled[1]?.status).toBe('rejected');
    expect(slow.thread).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);

    const fresh = makeClient();
    expect((await fresh.summarize(Q, [], 3)).count).toBe(5);
  });

  it('a thread that fails to load rejects pending calls', async () => {
    addEmbedded(1);
    const log = vi.fn();
    const client = makeClient({ dbPath: join(dir, 'missing', 'nope.db'), log });
    await expect(client.summarize(Q, [], 3)).rejects.toThrow(/scan thread/);
    expect(log).toHaveBeenCalledTimes(1);
    expect(client.thread).toBeUndefined();
  });

  it('a load that never posts ready times out, rejects pending and respawns', async () => {
    addEmbedded(5);
    const log = vi.fn();
    const hung = makeClient({ loadTimeoutMs: 1_000, testLoadDelayMs: 5_000, log });
    const first = hung.summarize(Q, [], 3);
    const second = hung.summarize(Q, [], 3);
    const settled = await Promise.allSettled([first, second]);
    for (const s of settled) {
      expect(s.status).toBe('rejected');
      expect((s as PromiseRejectedResult).reason.message).toBe(
        'scan thread load timed out after 1000 ms',
      );
    }
    expect(hung.thread).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ event: 'scan-thread-load-timeout', ms: 1_000 });

    const fresh = makeClient();
    expect((await fresh.summarize(Q, [], 3)).count).toBe(5);
  });

  it('a normal load clears the load timer', async () => {
    addEmbedded(5);
    const log = vi.fn();
    const client = makeClient({ loadTimeoutMs: 1_500, log });
    await client.summarize(Q, [], 3);
    await new Promise((r) => setTimeout(r, 1_800));
    expect(client.thread).toBeDefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('close rejects pending and leaves no live thread', async () => {
    addEmbedded(5);
    const baseline = process.getActiveResourcesInfo().length;
    const client = makeClient({ testDelayMs: 200, timeoutMs: 5_000 });
    await client.summarize(Q, [], 3);
    const live = client.thread;
    expect(live).toBeDefined();
    const pending = client.summarize(Q, [], 3);
    const rejected = expect(pending).rejects.toThrow('scan thread closed');
    await client.close();
    await rejected;
    expect(client.thread).toBeUndefined();
    expect(live?.threadId).toBe(-1);
    await expect(client.summarize(Q, [], 3)).rejects.toThrow('scan thread closed');
    await new Promise((r) => setImmediate(r));
    expect(process.getActiveResourcesInfo().length).toBeLessThanOrEqual(baseline);
  });
});
