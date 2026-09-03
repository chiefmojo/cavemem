import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getOrCreateToken } from '../src/security.js';
import { buildApp } from '../src/server.js';

const PORT = defaultSettings.workerPort;
const HOST = `127.0.0.1:${PORT}`;
const TOKEN = 'test-token';

let dir: string;
let store: MemoryStore;
let app: Hono;

function seed(): { sessionId: string; a: number; b: number } {
  store.startSession({ id: 's1', ide: 'claude-code', cwd: '/tmp' });
  const a = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'The db config lives at /etc/caveman.conf.',
  });
  const b = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'Please run `pnpm test` now.',
  });
  return { sessionId: 's1', a, b };
}

/** Every real request carries a valid Host header; tests opt out per-case to probe rejection. */
async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('host')) headers.set('host', HOST);
  return app.request(path, { ...init, headers });
}

/** Same as `req`, plus a valid bearer token for /api/* routes. */
async function apiReq(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${TOKEN}`);
  return req(path, { ...init, headers });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-worker-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  app = buildApp(store, { port: PORT, token: TOKEN });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('worker HTTP', () => {
  it('GET /healthz returns ok', async () => {
    const res = await req('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /api/sessions returns a session list', async () => {
    seed();
    const res = await apiReq('/api/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((s) => s.id)).toContain('s1');
  });

  it('GET /api/sessions/:id/observations returns expanded text', async () => {
    seed();
    const res = await apiReq('/api/sessions/s1/observations');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ content: string }>;
    expect(rows.length).toBeGreaterThan(0);
    // Database abbreviation should be expanded for the viewer.
    expect(rows.some((r) => /database/.test(r.content))).toBe(true);
    // Tech tokens preserved.
    expect(rows.some((r) => r.content.includes('/etc/caveman.conf'))).toBe(true);
  });

  it('GET /api/search returns matching observations', async () => {
    seed();
    const res = await apiReq('/api/search?q=config');
    expect(res.status).toBe(200);
    const hits = (await res.json()) as Array<{ id: number; snippet: string }>;
    expect(hits.length).toBeGreaterThan(0);
  });

  it('GET / renders the session index HTML', async () => {
    seed();
    const res = await apiReq('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('s1');
  });

  it('GET /sessions/:id renders observation HTML', async () => {
    seed();
    const res = await apiReq('/sessions/s1');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('/etc/caveman.conf');
  });

  it('GET /sessions/:unknown returns 404', async () => {
    const res = await apiReq('/sessions/does-not-exist');
    expect(res.status).toBe(404);
  });

  describe('Host allowlist', () => {
    it('rejects a mismatched Host header (DNS rebinding)', async () => {
      const res = await req('/healthz', { headers: { host: 'evil.example:37777' } });
      expect(res.status).toBe(403);
    });

    it('rejects a missing Host header', async () => {
      const res = await app.request('/healthz');
      expect(res.status).toBe(403);
    });

    it('accepts localhost:<port> as well as 127.0.0.1:<port>', async () => {
      const res = await req('/healthz', { headers: { host: `localhost:${PORT}` } });
      expect(res.status).toBe(200);
    });
  });

  describe('Origin check', () => {
    it('rejects a foreign Origin header', async () => {
      const res = await req('/healthz', { headers: { origin: 'http://evil.example' } });
      expect(res.status).toBe(403);
    });

    it('allows requests with no Origin header', async () => {
      const res = await req('/healthz');
      expect(res.status).toBe(200);
    });

    it('allows a matching Origin header', async () => {
      const res = await req('/healthz', { headers: { origin: `http://${HOST}` } });
      expect(res.status).toBe(200);
    });

    it('never adds CORS headers', async () => {
      const res = await req('/healthz', { headers: { origin: `http://${HOST}` } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('Bearer token on /api/*', () => {
    it('rejects a missing token', async () => {
      const res = await req('/api/sessions');
      expect(res.status).toBe(401);
    });

    it('rejects a wrong token', async () => {
      const res = await req('/api/sessions', { headers: { authorization: 'Bearer wrong' } });
      expect(res.status).toBe(401);
    });

    it('accepts the correct token via Authorization: Bearer', async () => {
      const res = await apiReq('/api/sessions');
      expect(res.status).toBe(200);
    });

    it('accepts the correct token via X-Cavemem-Token', async () => {
      const res = await req('/api/sessions', { headers: { 'x-cavemem-token': TOKEN } });
      expect(res.status).toBe(200);
    });

    it('rejects unauthenticated HTML routes', async () => {
      const res = await req('/');
      expect(res.status).toBe(401);
    });
  });

  describe('viewer HTML token injection', () => {
    it('embeds the token as window.__CAVEMEM_TOKEN__ on the index page', async () => {
      const res = await apiReq('/');
      const body = await res.text();
      expect(body).toContain(`window.__CAVEMEM_TOKEN__=${JSON.stringify(TOKEN)}`);
    });

    it('embeds the token on a session page', async () => {
      seed();
      const res = await apiReq('/sessions/s1');
      const body = await res.text();
      expect(body).toContain(`window.__CAVEMEM_TOKEN__=${JSON.stringify(TOKEN)}`);
    });
  });
});

describe('worker token file', () => {
  let tokenDir: string;

  beforeEach(() => {
    tokenDir = mkdtempSync(join(tmpdir(), 'cavemem-token-'));
  });

  afterEach(() => {
    rmSync(tokenDir, { recursive: true, force: true });
  });

  it('creates a token file with mode 0600 on first call', () => {
    const settings = { ...defaultSettings, dataDir: tokenDir };
    const token = getOrCreateToken(settings);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const tokenPath = join(tokenDir, 'worker-token');
    expect(existsSync(tokenPath)).toBe(true);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('reuses the existing token on subsequent calls', () => {
    const settings = { ...defaultSettings, dataDir: tokenDir };
    const first = getOrCreateToken(settings);
    const second = getOrCreateToken(settings);
    expect(second).toBe(first);
  });
});

describe('worker allowlist', () => {
  it('rejects a LAN Host header when no allowlist is configured', async () => {
    const res = await app.request('/healthz', { headers: { host: 'neuromancer:37777' } });
    expect(res.status).toBe(403);
  });

  it('accepts a configured LAN Host header and still accepts loopback', async () => {
    const lan = buildApp(store, { port: PORT, token: TOKEN, allowedHosts: ['neuromancer:37777'] });
    const a = await lan.request('/healthz', { headers: { host: 'neuromancer:37777' } });
    expect(a.status).toBe(200);
    const b = await lan.request('/healthz', { headers: { host: HOST } });
    expect(b.status).toBe(200);
    const c = await lan.request('/healthz', { headers: { host: 'other:37777' } });
    expect(c.status).toBe(403);
  });

  it('accepts an Origin matching an allowlisted host and rejects others', async () => {
    const lan = buildApp(store, { port: PORT, token: TOKEN, allowedHosts: ['neuromancer:37777'] });
    const ok = await lan.request('/healthz', {
      headers: { host: 'neuromancer:37777', origin: 'http://neuromancer:37777' },
    });
    expect(ok.status).toBe(200);
    const bad = await lan.request('/healthz', {
      headers: { host: 'neuromancer:37777', origin: 'http://evil.example' },
    });
    expect(bad.status).toBe(403);
  });
});

describe('POST /api/hooks/:event', () => {
  it('rejects without bearer', async () => {
    const res = await req('/api/hooks/session-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'h1' }),
    });
    expect(res.status).toBe(401);
  });

  it('runs session-start and returns a HookResult', async () => {
    const res = await apiReq('/api/hooks/session-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'h1',
        ide: 'claude-code',
        cwd: '/tmp',
        metadata: { host: 'wintermute' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; context?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.context).toBe('string');
    const row = store.storage.getSession('h1');
    expect(row?.ide).toBe('claude-code');
    expect(JSON.parse(row?.metadata ?? '{}').host).toBe('wintermute');
  });

  it('user-prompt-submit lands a compressed observation', async () => {
    await apiReq('/api/hooks/session-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'h2', ide: 'codex' }),
    });
    const res = await apiReq('/api/hooks/user-prompt-submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'h2', prompt: 'Please basically fix /etc/hosts' }),
    });
    expect(res.status).toBe(200);
    const tl = store.timeline('h2');
    expect(tl).toHaveLength(1);
    expect(tl[0]?.content).toContain('/etc/hosts');
    expect(tl[0]?.content).not.toBe('Please basically fix /etc/hosts');
    expect(tl[0]?.content).not.toContain('basically');
  });

  it('runs post-tool-use, stop, and session-end handlers', async () => {
    await apiReq('/api/hooks/session-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'h3', ide: 'codex' }),
    });
    const tool = await apiReq('/api/hooks/post-tool-use', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'h3',
        tool_name: 'Read',
        tool_input: { path: '/tmp/input.txt' },
        tool_response: 'contents',
      }),
    });
    expect(tool.status).toBe(200);
    expect(((await tool.json()) as { ok: boolean }).ok).toBe(true);
    expect(store.timeline('h3')).toHaveLength(1);
    expect(store.timeline('h3')[0]?.kind).toBe('tool_use');

    const stop = await apiReq('/api/hooks/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'h3', last_assistant_message: 'Fixed the bug.' }),
    });
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as { ok: boolean }).ok).toBe(true);
    expect(store.storage.listSummaries('h3').filter((s) => s.scope === 'turn')).toHaveLength(1);

    const end = await apiReq('/api/hooks/session-end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'h3' }),
    });
    expect(end.status).toBe(200);
    expect(((await end.json()) as { ok: boolean }).ok).toBe(true);
    expect(store.storage.listSummaries('h3').filter((s) => s.scope === 'session')).toHaveLength(1);
    expect(store.storage.getSession('h3')?.ended_at).not.toBeNull();
  });

  it('returns a failed HookResult with HTTP 200 when a handler fails', async () => {
    const brokenStore = new MemoryStore({
      dbPath: join(dir, 'broken.db'),
      settings: defaultSettings,
    });
    const brokenApp = buildApp(brokenStore, { port: PORT, token: TOKEN });
    brokenStore.close();
    const res = await brokenApp.request('/api/hooks/session-start', {
      method: 'POST',
      headers: {
        host: HOST,
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ session_id: 'broken', ide: 'codex' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      error: expect.any(String),
      ms: expect.any(Number),
    });
  });

  it('400 on unknown event and on missing session_id', async () => {
    const a = await apiReq('/api/hooks/not-a-hook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"session_id":"x"}',
    });
    expect(a.status).toBe(400);
    const b = await apiReq('/api/hooks/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"last_assistant_message":"hi"}',
    });
    expect(b.status).toBe(400);
    const c = await apiReq('/api/hooks/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(c.status).toBe(400);
  });
});
