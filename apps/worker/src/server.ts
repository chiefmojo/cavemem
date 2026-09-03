#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expand } from '@cavemem/compress';
import { type Settings, loadSettings, resolveDataDir } from '@cavemem/config';
import { type Embedder, MemoryStore } from '@cavemem/core';
import { createEmbedder } from '@cavemem/embedding';
import { type HookInput, type HookName, runHook } from '@cavemem/hooks';
import { buildServer } from '@cavemem/mcp-server';
import { serve } from '@hono/node-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type EmbedLoopHandle, startEmbedLoop, stateFilePath } from './embed-loop.js';
import {
  allowedHostSet,
  bearerAuth,
  getOrCreateToken,
  hostAllowlist,
  originCheck,
} from './security.js';
import { renderIndex, renderSession } from './viewer.js';

export interface BuildAppOptions {
  /** Port the worker binds to — used by the Host/Origin allowlist checks. */
  port: number;
  /** Bearer token required on /api/*; also injected into served HTML. */
  token: string;
  /** Extra host:port values accepted in Host/Origin (settings.workerAllowedHosts). */
  allowedHosts?: string[];
  /** Pre-loaded embedder shared with /mcp; null when provider=none or load failed. */
  embedder?: Embedder | null;
  loop?: EmbedLoopHandle | undefined;
}

const HOOK_NAMES: ReadonlySet<string> = new Set<HookName>([
  'session-start',
  'user-prompt-submit',
  'post-tool-use',
  'stop',
  'session-end',
]);

export function buildApp(store: MemoryStore, opts: BuildAppOptions): Hono {
  const app = new Hono();
  const { port, token, loop } = opts;

  // Host/Origin checks apply to every route (kills DNS rebinding + CSRF from
  // browser pages). Every route except healthz requires the bearer because a
  // LAN worker's viewer renders plaintext memory.
  const allowed = allowedHostSet(port, opts.allowedHosts ?? []);
  app.use('*', hostAllowlist(allowed));
  app.use('*', originCheck(allowed));
  app.use('*', async (_c, next) => {
    loop?.touch();
    await next();
  });
  app.use('*', async (c, next) => {
    if (c.req.path === '/healthz') return next();
    return bearerAuth(token)(c, next);
  });

  // Stateless streamable HTTP: one server + transport per request, as the SDK
  // requires when sessionIdGenerator is undefined. Tool registration is five
  // calls, so the per-request cost is negligible. Real MCP clients send no
  // Origin header; the shared originCheck still applies so a browser page
  // cannot reach this route (DNS rebinding).
  app.all('/mcp', async (c) => {
    const mcp = buildServer(store, store.settings, { embedder: opts.embedder ?? null });
    // Omitting the optional generator selects stateless mode. SDK 1.29's
    // declaration rejects an explicit `undefined` with exactOptionalPropertyTypes.
    const transport = new WebStandardStreamableHTTPServerTransport({});
    await mcp.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/api/state', (c) => {
    if (!loop) return c.json({ running: false });
    return c.json({ running: true, ...loop.state() });
  });

  app.get('/api/sessions', (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json(store.storage.listSessions(limit));
  });

  app.get('/api/sessions/:id/observations', (c) => {
    const id = c.req.param('id');
    const limit = Number(c.req.query('limit') ?? 200);
    const rows = store.timeline(id, undefined, limit);
    return c.json(rows.map((r) => ({ ...r, content: expand(r.content) })));
  });

  app.get('/api/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const limit = Number(c.req.query('limit') ?? 10);
    return c.json(await store.search(q, limit));
  });

  // Remote-mode write path. The client ships the raw IDE payload; the same
  // handlers that run in local mode run here against the worker's store, so
  // redaction, exclusion, and compression stay in one place (spec decision 4).
  app.post('/api/hooks/:event', bodyLimit({ maxSize: 1_048_576 }), async (c) => {
    const event = c.req.param('event');
    if (!HOOK_NAMES.has(event)) {
      return c.json({ error: `unknown hook event: ${event}` }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'body must be JSON' }, 400);
    }
    if (!body || typeof body !== 'object' || typeof (body as HookInput).session_id !== 'string') {
      return c.json({ error: 'session_id is required' }, 400);
    }
    const result = await runHook(event as HookName, body as HookInput, { store });
    return c.json(result);
  });

  app.get('/', (c) => c.html(renderIndex(store.storage.listSessions(50), token)));
  app.get('/sessions/:id', (c) => {
    const id = c.req.param('id');
    const session = store.storage.getSession(id);
    if (!session) return c.notFound();
    const obs = store.timeline(id, undefined, 500);
    return c.html(
      renderSession(
        session,
        obs.map((r) => ({ ...r, content: expand(r.content) })),
        token,
      ),
    );
  });

  return app;
}

function pidFilePath(settings: Settings): string {
  return join(resolveDataDir(settings.dataDir), 'worker.pid');
}

function writePidFile(settings: Settings): void {
  writeFileSync(pidFilePath(settings), String(process.pid));
}

function removePidFile(settings: Settings): void {
  try {
    unlinkSync(pidFilePath(settings));
  } catch {
    // already gone
  }
}

export async function start(): Promise<void> {
  const settings = loadSettings();
  const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
  const store = new MemoryStore({ dbPath, settings });

  writePidFile(settings);

  let loop: EmbedLoopHandle | undefined;
  const servers: Array<ReturnType<typeof serve>> = [];

  const shutdown = async () => {
    removePidFile(settings);
    if (loop) await loop.stop();
    for (const s of servers) s.close();
    store.close();
  };

  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });

  // Build embedder if provider != 'none'. Model load runs in the worker
  // process only — hooks never wait for it.
  let embedder: Embedder | null = null;
  try {
    embedder = await createEmbedder(settings, {
      log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (err) {
    process.stderr.write(
      `[cavemem worker] embedder unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  if (embedder) {
    loop = startEmbedLoop({
      store,
      embedder,
      settings,
      onIdleExit: () => {
        shutdown().finally(() => process.exit(0));
      },
    });
  } else {
    // Still write a minimal state file so `cavemem status` has something to show.
    writeFileSync(
      stateFilePath(settings),
      `${JSON.stringify(
        {
          provider: settings.embedding.provider,
          model: settings.embedding.model,
          dim: 0,
          embedded: 0,
          total: store.storage.countObservations(),
          lastBatchAt: null,
          lastBatchMs: null,
          lastError: null,
          lastHttpAt: Date.now(),
          startedAt: Date.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  const token = getOrCreateToken(settings);
  const app = buildApp(store, {
    port: settings.workerPort,
    token,
    allowedHosts: settings.workerAllowedHosts,
    embedder,
    loop,
  });
  servers.push(
    serve({ fetch: app.fetch, port: settings.workerPort, hostname: settings.workerHost }),
  );
  process.stderr.write(
    `[cavemem worker] listening on http://${settings.workerHost}:${settings.workerPort} (pid ${process.pid})\n`,
  );
  if (settings.workerHost !== '127.0.0.1' && settings.workerAllowedHosts.length === 0) {
    process.stderr.write(
      '[cavemem worker] warning: bound off loopback with empty workerAllowedHosts — every non-loopback request will be rejected with 403\n',
    );
  }
}

if (isMainEntry()) {
  start().catch((err) => {
    process.stderr.write(`[cavemem worker] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

function isMainEntry(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return import.meta.url === pathToFileURL(argv).href;
  }
}
