import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as embedding from '@cavemem/embedding';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let client: Client;

async function seed(): Promise<{ a: number; b: number }> {
  store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
  const a = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'The db config lives at /etc/caveman.conf.',
  });
  const b = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'Please just run `cargo build --release` tomorrow.',
  });
  return { a, b };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-mcp-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('lists the cavemem tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_observations',
      'list_sessions',
      'search',
      'timeline',
    ]);
  });

  it('search returns compact hits (id, snippet, score, ts)', async () => {
    await seed();
    const res = await client.callTool({ name: 'search', arguments: { query: 'cargo' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const hits = JSON.parse(text) as Array<{ id: number; snippet: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h).toHaveProperty('id');
      expect(h).toHaveProperty('snippet');
      expect(h).toHaveProperty('score');
      // No full body leaks into the compact shape.
      expect(Object.keys(h).sort()).toEqual(['id', 'score', 'session_id', 'snippet', 'ts']);
    }
  });

  it('timeline returns id/kind/ts only (progressive disclosure)', async () => {
    await seed();
    const res = await client.callTool({ name: 'timeline', arguments: { session_id: 's1' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['id', 'kind', 'ts']);
    }
  });

  it('get_observations returns expanded text by default and preserves tech tokens', async () => {
    const { a } = await seed();
    const res = await client.callTool({ name: 'get_observations', arguments: { ids: [a] } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<{ id: number; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toContain('/etc/caveman.conf');
    expect(rows[0]?.content).toMatch(/database/);
  });

  it('get_observations with expand=false returns the compressed stored form', async () => {
    const { b } = await seed();
    const res = await client.callTool({
      name: 'get_observations',
      arguments: { ids: [b], expand: false },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<{ content: string }>;
    // Compression drops "Please just" but keeps the command intact.
    expect(rows[0]?.content).not.toMatch(/Please just/);
    expect(rows[0]?.content).toContain('`cargo build --release`');
  });

  it('get_observations reports an error on invalid input (empty ids)', async () => {
    const res = await client.callTool({
      name: 'get_observations',
      arguments: { ids: [] },
    });
    expect(res.isError).toBe(true);
  });
});

describe('buildServer embedder injection', () => {
  it('uses the injected embedder instead of loading one', async () => {
    const calls: string[] = [];
    const fake = {
      model: 'fake',
      dim: 3,
      embed: async (text: string) => {
        calls.push(text);
        return new Float32Array([1, 0, 0]);
      },
    };
    const server = buildServer(store, defaultSettings, { embedder: fake });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), c.connect(ct)]);
    await seed();
    const semanticOnly = store.addObservation({
      session_id: 's1',
      kind: 'note',
      content: 'A quiet note about weather patterns.',
    });
    store.storage.putEmbedding(semanticOnly, fake.model, new Float32Array([1, 0, 0]));
    const res = await c.callTool({ name: 'search', arguments: { query: 'cargo' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const hits = JSON.parse(text) as Array<{ id: number }>;
    expect(hits.some((hit) => hit.id === semanticOnly)).toBe(true);
    expect(calls).toEqual(['cargo']);
    await c.close();
  });

  it('uses BM25 only when null is injected without lazy-loading an embedder', async () => {
    const createEmbedder = vi
      .spyOn(embedding, 'createEmbedder')
      .mockRejectedValue(new Error('must not load'));
    const server = buildServer(store, defaultSettings, { embedder: null });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), c.connect(ct)]);
    await seed();
    const res = await c.callTool({ name: 'search', arguments: { query: 'cargo' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const hits = JSON.parse(text) as Array<{ snippet: string }>;
    expect(hits.some((hit) => hit.snippet.includes('cargo'))).toBe(true);
    expect(createEmbedder).not.toHaveBeenCalled();
    await c.close();
    createEmbedder.mockRestore();
  });
});
