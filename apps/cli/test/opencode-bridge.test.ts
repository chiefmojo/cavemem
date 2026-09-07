import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SystemTransform = (
  input: { sessionID?: string; model: unknown },
  output: { system: string[] },
) => Promise<void>;

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
    if (origHome === undefined) delete process.env.CAVEMEM_HOME;
    else process.env.CAVEMEM_HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function loadBridge(settings: Record<string, unknown>): Promise<{
    'experimental.chat.system.transform': SystemTransform;
  }> {
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ embedding: { provider: 'none' }, ...settings }),
    );
    const mod = await import('../src/opencode-bridge.js');
    const hooks = (await mod.default({ $: {} as never, directory: '/proj' })) as Record<
      string,
      SystemTransform
    >;
    return {
      'experimental.chat.system.transform': hooks[
        'experimental.chat.system.transform'
      ] as SystemTransform,
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

  it('expands compressed hints client-side', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            hints: [{ sessionId: 'old-1', content: 'plain note', compressed: true }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    expect(system).toContain('Prior context (internal): plain note');
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

  it('degrades to no priming on invalid remote.url without throwing at init', async () => {
    // canonicalRemoteUrl rejects URLs with a path/query/fragment;
    // checkedRemoteTarget rethrows — init must catch it, not crash the plugin.
    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777/has/path', token: 'tok' } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
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
