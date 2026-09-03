import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-mcp-http-'));
  store = new MemoryStore({
    dbPath: join(dir, 'data.db'),
    settings: { ...defaultSettings, embedding: { ...defaultSettings.embedding, provider: 'none' } },
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

describe('MCP over streamable HTTP', () => {
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
