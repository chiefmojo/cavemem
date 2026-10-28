import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { type Embedder, MemoryStore } from '@cavemem/core';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScanClient } from '../src/scan-client.js';
import { SearchHealth } from '../src/search-health.js';
import { buildApp } from '../src/server.js';
import { scanThreadFromSource } from './support/scan-thread.js';

const TOKEN = 'stall-test-token';
const MODEL = 'stall-embedder';
const DIM = 384;
const ROWS = 60_000;

// Cheap and deterministic: seeding and querying must not dominate the run.
function embedText(text: string): Float32Array {
  const v = new Float32Array(DIM);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  for (let i = 0; i < DIM; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) + i;
    v[i] = ((h >>> 8) % 2000) / 1000 - 1;
  }
  return v;
}

const embedder: Embedder = { model: MODEL, dim: DIM, embed: async (t) => embedText(t) };

let dir: string;
let store: MemoryStore;
let scan: ScanClient | undefined;
let server: ReturnType<typeof serve> | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      s.close(() => resolve(addr.port));
    });
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-stall-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(async () => {
  await scan?.close();
  scan = undefined;
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('event loop under hybrid search', () => {
  it('a large corpus does not stall unrelated requests', { timeout: 120_000 }, async () => {
    store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
    store.storage.transaction(() => {
      for (let i = 0; i < ROWS; i++) {
        const content = `note ${i} ${i % 50 === 0 ? 'cargo' : 'pnpm'} topic${i % 97}`;
        const id = store.storage.insertObservation({
          session_id: 's1',
          kind: 'note',
          content,
          compressed: true,
          intensity: 'full',
        });
        store.storage.putEmbedding(id, MODEL, embedText(content));
      }
    });

    scan = new ScanClient({
      dbPath: join(dir, 'data.db'),
      model: MODEL,
      dim: DIM,
      log: () => {},
      ...scanThreadFromSource,
    });
    const port = await freePort();
    const app = buildApp(store, {
      port,
      token: TOKEN,
      embedder,
      vectorIndex: scan,
      health: new SearchHealth({ log: () => {} }),
    });
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: 'stall', version: '0.0.0' });
    await client.connect(transport as Parameters<typeof client.connect>[0]);

    const probes: number[] = [];
    let searching = true;
    const probe = (async () => {
      while (searching) {
        const t0 = performance.now();
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        await res.arrayBuffer();
        probes.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 10));
      }
    })();

    for (let i = 0; i < 5; i++) {
      const res = await client.callTool({
        name: 'search',
        arguments: { query: `cargo topic${i}`, limit: 10 },
      });
      expect(res.isError).toBeFalsy();
    }
    searching = false;
    await probe;
    await client.close();

    const sorted = [...probes].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] as number;
    const max = sorted[sorted.length - 1] as number;
    const detail = `probe n=${probes.length} p95=${p95.toFixed(1)} ms max=${max.toFixed(1)} ms`;
    expect(probes.length, detail).toBeGreaterThan(20);
    expect(p95, detail).toBeLessThan(50);
  });
});
