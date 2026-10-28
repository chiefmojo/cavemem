import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { type Embedder, MemoryStore, type VectorIndex } from '@cavemem/core';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanClient } from '../src/scan-client.js';
import { SearchHealth } from '../src/search-health.js';
import { buildApp } from '../src/server.js';
import { scanThreadFromSource } from './support/scan-thread.js';

const TOKEN = 'mcp-test-token';

let dir: string;
let store: MemoryStore;
let port: number;
let server: ReturnType<typeof serve>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const p = addr.port;
      s.close(() => resolve(p));
    });
  });
}

function url(): URL {
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

async function connect(headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url(), { requestInit: { headers } });
  const client = new Client({ name: 'test', version: '0.0.0' });
  // SDK 1.29 declares its transport getter as `string | undefined` while the
  // Transport interface uses an optional string, which conflicts under this
  // repo's exactOptionalPropertyTypes setting despite being runtime-compatible.
  await client.connect(transport as Parameters<typeof client.connect>[0]);
  return client;
}

describe('MCP over streamable HTTP', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cavemem-mcp-http-'));
    store = new MemoryStore({
      dbPath: join(dir, 'data.db'),
      settings: {
        ...defaultSettings,
        embedding: { ...defaultSettings.embedding, provider: 'none' },
      },
    });
    port = await freePort();
    const app = buildApp(store, { port, token: TOKEN, embedder: null });
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists tools and searches through the worker', async () => {
    store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
    const id = store.addObservation({
      session_id: 's1',
      kind: 'note',
      content: 'Please run `cargo build --release` tomorrow.',
    });
    const client = await connect({ authorization: `Bearer ${TOKEN}` });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_observations',
      'list_sessions',
      'search',
      'timeline',
    ]);
    const res = await client.callTool({ name: 'search', arguments: { query: 'cargo' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const hits = JSON.parse(text) as Array<{ id: number }>;
    expect(hits.map((h) => h.id)).toContain(id);
    const bodies = await client.callTool({ name: 'get_observations', arguments: { ids: [id] } });
    const bt = (bodies.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    expect(bt).toContain('cargo build --release');
    const timeline = await client.callTool({
      name: 'timeline',
      arguments: { session_id: 's1' },
    });
    const tt = (timeline.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(tt) as Array<{ id: number; kind: string }>;
    expect(rows.map(({ id: rowId, kind }) => ({ id: rowId, kind }))).toEqual([
      { id, kind: 'note' },
    ]);
    const sessions = await client.callTool({ name: 'list_sessions', arguments: {} });
    const st = (sessions.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const listed = JSON.parse(st) as Array<{ id: string; ide: string; cwd: string }>;
    expect(listed).toEqual([expect.objectContaining({ id: 's1', ide: 'test', cwd: '/tmp' })]);
    await client.close();
  });

  it('rejects without bearer', async () => {
    await expect(connect({})).rejects.toMatchObject({ code: 401 });
  });

  it('rejects a browser-style Origin', async () => {
    await expect(
      connect({ authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' }),
    ).rejects.toMatchObject({ code: 403 });
  });
});

const DIM = 16;
const MODEL = 'test-embedder';

/** Deterministic pseudo-embedding: the same text always maps to the same vector. */
function embedText(text: string): Float32Array {
  const v = new Float32Array(DIM);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    v[i % DIM] = (v[i % DIM] as number) + ((h >>> 8) % 1000) / 500 - 1;
  }
  return v;
}

const embedder: Embedder = {
  model: MODEL,
  dim: DIM,
  embed: async (text) => embedText(text),
};

type SearchHit = { id: number; score: number };

async function searchOverMcp(client: Client, query: string, limit = 10) {
  return client.callTool({ name: 'search', arguments: { query, limit } });
}

describe('hybrid search over /mcp', () => {
  let scan: ScanClient | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cavemem-mcp-hybrid-'));
    store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
    store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
    store.storage.transaction(() => {
      for (let i = 0; i < 200; i++) {
        const content = `note ${i}: ${i % 3 === 0 ? 'cargo build' : 'pnpm test'} topic${i % 17}`;
        const id = store.addObservation({ session_id: 's1', kind: 'note', content });
        store.storage.putEmbedding(id, MODEL, embedText(content));
      }
    });
  });

  afterEach(async () => {
    await scan?.close();
    scan = undefined;
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function mount(index: VectorIndex, health: SearchHealth): Promise<Client> {
    port = await freePort();
    const app = buildApp(store, { port, token: TOKEN, embedder, vectorIndex: index, health });
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
    return connect({ authorization: `Bearer ${TOKEN}` });
  }

  it('hybrid search over /mcp returns the oracle ranking', async () => {
    scan = new ScanClient({
      dbPath: join(dir, 'data.db'),
      model: MODEL,
      dim: DIM,
      log: () => {},
      ...scanThreadFromSource,
    });
    const health = new SearchHealth({ log: () => {} });
    const recorded = vi.spyOn(health, 'recordSuccess');
    const client = await mount(scan, health);

    const res = await searchOverMcp(client, 'cargo topic3');
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? '[]';
    const got = JSON.parse(text) as SearchHit[];
    const oracle = await store.search('cargo topic3', 10, embedder);

    expect(res.isError).toBeFalsy();
    expect(oracle.length).toBeGreaterThan(0);
    expect(got.map((h) => h.id)).toEqual(oracle.map((h) => h.id));
    got.forEach((h, i) => expect(h.score).toBeCloseTo(oracle[i]?.score as number, 9));
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({ count: 200, warmup: true, queuedMs: 0 }),
    );
    await client.close();
  });

  it('a failing index surfaces a tool error and records a failure', async () => {
    const failing: VectorIndex = { summarize: () => Promise.reject(new Error('index down')) };
    const health = new SearchHealth({ log: () => {} });
    const client = await mount(failing, health);

    for (let i = 0; i < 3; i++) {
      const res = await searchOverMcp(client, 'cargo');
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0]?.text).toContain('index down');
    }
    expect(health.warning()?.startsWith('cavemem: hybrid search failing (3 of last 20)')).toBe(
      true,
    );
    await client.close();
  });

  it('keyword-only searches record nothing', async () => {
    const never: VectorIndex = { summarize: () => Promise.reject(new Error('unused')) };
    const health = new SearchHealth({ log: () => {} });
    const ok = vi.spyOn(health, 'recordSuccess');
    const bad = vi.spyOn(health, 'recordFailure');
    port = await freePort();
    // No embedder: the index must never be consulted and nothing is recorded.
    const app = buildApp(store, { port, token: TOKEN, embedder: null, vectorIndex: never, health });
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
    const client = await connect({ authorization: `Bearer ${TOKEN}` });
    const res = await searchOverMcp(client, 'cargo');
    expect(res.isError).toBeFalsy();
    expect(ok).not.toHaveBeenCalled();
    expect(bad).not.toHaveBeenCalled();
    await client.close();
  });
});
