import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SystemTransform = (
  input: { sessionID?: string; model: unknown },
  output: { system: string[] },
) => Promise<void>;

type EventHook = (input: {
  event: { type: string; properties?: Record<string, unknown> };
}) => Promise<void>;

/** Minimal ChildProcess shape the bridge's fire-and-forget runHook touches. */
function fakeChild(): ChildProcess {
  return {
    on: () => {},
    stdin: { on: () => {}, end: () => {} },
    unref: () => {},
  } as unknown as ChildProcess;
}

// Pass-through mock: node built-in ESM namespaces are non-configurable, so
// vi.spyOn(namespace, 'spawn') fails on the raw object. Wrapping the module
// in a factory hands out a vitest proxy namespace whose properties are
// spyable, while every export still delegates to the real implementation.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

describe('opencode-bridge prior-context priming', () => {
  let home: string;
  let origHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cavemem-bridge-test-'));
    origHome = process.env.CAVEMEM_HOME;
    process.env.CAVEMEM_HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (origHome === undefined) delete process.env.CAVEMEM_HOME;
    else process.env.CAVEMEM_HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function loadBridge(settings: Record<string, unknown>): Promise<{
    'experimental.chat.system.transform': SystemTransform;
    event: EventHook;
  }> {
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ embedding: { provider: 'none' }, ...settings }),
    );
    const mod = await import('../src/opencode-bridge.js');
    const hooks = (await mod.default({ $: {} as never, directory: '/proj' })) as Record<
      string,
      SystemTransform | EventHook
    >;
    return {
      'experimental.chat.system.transform': hooks[
        'experimental.chat.system.transform'
      ] as SystemTransform,
      event: hooks.event as EventHook,
    };
  }

  async function prime(hooks: { 'experimental.chat.system.transform': SystemTransform }) {
    const output = { system: [] as string[] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses-1', model: {} }, output);
    return output.system;
  }

  it('primes from the worker in remote mode', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            hints: [{ sessionId: 'old-1', content: 'earlier session solved X', compressed: false }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/context');
    expect(url.searchParams.get('cwd')).toBe('/proj');
    expect(url.searchParams.get('exclude')).toBe('ses-1');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(system).toContain('Prior context (internal): earlier session solved X');
  });

  it('expands compressed hints client-side and passes uncompressed hints through verbatim', async () => {
    // 'db'/'cfg' expand to 'database'/'configuration' — a discriminating
    // fixture: the compressed hint must come back expanded, the control
    // hint (compressed: false) must keep the abbreviations byte-for-byte.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            hints: [
              { sessionId: 'old-1', content: 'fixed the db cfg', compressed: true },
              { sessionId: 'old-2', content: 'db cfg note kept as stored', compressed: false },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    expect(system).toContain(
      'Prior context (internal): fixed the database configuration | db cfg note kept as stored',
    );
  });

  it('fail-open: remote 500 yields no priming and no throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
  });

  it('never logs the remote token when fetch throws an invalid-header error', async () => {
    const logPath = join(tmpdir(), 'cavemem-bridge-errors.log');
    let logBefore = '';
    try {
      logBefore = readFileSync(logPath, 'utf8');
    } catch {
      // No log file yet.
    }
    // undici's header validation throws a TypeError whose message quotes the
    // full authorization value — if that message reaches the bridge log, the
    // token is disclosed.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(`Headers.append: "Bearer tok" is an invalid header value.`);
      }),
    );

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
    const appended = readFileSync(logPath, 'utf8').slice(logBefore.length);
    // Fixed error category only — never the exception message.
    expect(appended).toContain('retrieval error: TypeError');
    expect(appended).not.toContain('tok');
  });

  it('degrades to no priming on invalid remote.url without throwing at init', async () => {
    // canonicalRemoteUrl rejects URLs with a path/query/fragment;
    // checkedRemoteTarget rethrows — init must catch it, not crash the plugin.
    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777/has/path', token: 'tok' } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
  });

  it('fail-open: fetch timeout aborts the wait and yields no priming', async () => {
    // Never resolves on its own — only the bridge's AbortSignal.timeout can
    // settle it. If the bridge ignored the abort (or hung), this test times
    // out; if it threw, prime() rejects.
    const fetchMock = vi.fn((_url: URL | string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 20 } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('suppresses repeat context fetches for the same sessionID', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ hints: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Same plugin instance, same sessionID twice: the queriedSessions guard
    // must dedupe (the session.idle reset is deliberately not exercised here).
    const hooks = await loadBridge({
      remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 },
    });
    await prime(hooks);
    await prime(hooks);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('remote mode never creates the client-local data.db', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            hints: [{ sessionId: 'old-1', content: 'remote hint', compressed: false }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    // Priming came from the worker, not a store opened on the temp home —
    // opening it would create a junk empty data.db on remote clients.
    expect(system).toContain('Prior context (internal): remote hint');
    expect(existsSync(join(home, 'data.db'))).toBe(false);
  });

  it('degraded init keeps the write dispatch alive', async () => {
    // Spy BEFORE importing the bridge: after vi.resetModules() the bridge's
    // own 'node:child_process' import resolves to the same proxied namespace.
    const childProcess = await import('node:child_process');
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(fakeChild);

    const hooks = await loadBridge({
      remote: { url: 'http://worker:37777/has/path', token: 'tok' },
    });
    await expect(
      hooks.event({
        event: {
          type: 'session.created',
          properties: { info: { id: 'ses-9', directory: '/proj' } },
        },
      }),
    ).resolves.toBeUndefined();

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[1]).toEqual([
      'hook',
      'run',
      'session-start',
      '--ide',
      'opencode',
    ]);
  });

  it('local mode reads the client-local store exactly as before', async () => {
    const dbPath = join(home, 'data.db');
    const seed = new MemoryStore({ dbPath, settings: defaultSettings });
    seed.startSession({ id: 'local-1', ide: 'opencode', cwd: '/proj', metadata: null });
    seed.endSession('local-1');
    seed.storage.insertSummary({
      session_id: 'local-1',
      scope: 'session',
      content: 'local summary text',
      compressed: false,
      intensity: null,
    });
    seed.close();

    const system = await prime(await loadBridge({ dataDir: home }));

    expect(system).toContain('Prior context (internal): local summary text');
  });
});
