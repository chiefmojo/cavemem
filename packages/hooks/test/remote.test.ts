import { defaultSettings } from '@cavemem/config';
import { describe, expect, it } from 'vitest';
import { RemoteAuthError, postHook, remoteTarget } from '../src/remote.js';

const target = { url: 'http://neuromancer:37777', token: 'tok', timeoutMs: 200 };

function fakeFetch(status: number, body: unknown, delayMs = 0): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    if (delayMs) {
      await new Promise((r, rej) => {
        const t = setTimeout(r, delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          rej(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('remoteTarget', () => {
  it('is null without remote.url', () => {
    expect(remoteTarget(defaultSettings)).toBeNull();
  });
  it('strips a trailing slash and carries token + timeout', () => {
    const t = remoteTarget({
      ...defaultSettings,
      remote: { url: 'http://neuromancer:37777/', token: 'x', timeoutMs: 999 },
    });
    expect(t).toEqual({ url: 'http://neuromancer:37777', token: 'x', timeoutMs: 999 });
  });
});

describe('postHook', () => {
  it('POSTs to /api/hooks/<event> with bearer and returns the HookResult', async () => {
    let seenUrl = '';
    let seenAuth = '';
    let seenBody = '';
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get('authorization') ?? '';
      seenBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true, ms: 3, context: 'ctx' }), { status: 200 });
    }) as typeof fetch;
    const r = await postHook(target, 'session-start', { session_id: 's1' }, f);
    expect(seenUrl).toBe('http://neuromancer:37777/api/hooks/session-start');
    expect(seenAuth).toBe('Bearer tok');
    expect(JSON.parse(seenBody).session_id).toBe('s1');
    expect(r).toEqual({ ok: true, ms: 3, context: 'ctx' });
  });

  it('throws RemoteAuthError on 401', async () => {
    await expect(
      postHook(target, 'stop', { session_id: 's' }, fakeFetch(401, 'Unauthorized')),
    ).rejects.toBeInstanceOf(RemoteAuthError);
  });

  it('throws a plain Error on 500', async () => {
    await expect(
      postHook(target, 'stop', { session_id: 's' }, fakeFetch(500, { error: 'boom' })),
    ).rejects.toThrow(/500/);
  });

  it('aborts after timeoutMs', async () => {
    await expect(
      postHook(target, 'stop', { session_id: 's' }, fakeFetch(200, { ok: true, ms: 1 }, 1000)),
    ).rejects.toThrow(/abort/i);
  });
});
