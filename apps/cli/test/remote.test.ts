import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeRemote, remoteSearch } from '../src/util/remote.js';

const target = {
  url: 'http://neuromancer:37777',
  token: 'test-token',
  timeoutMs: 1500,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remote CLI requests', () => {
  it('searches the authenticated API endpoint with the requested query and limit', async () => {
    const hits = [{ id: 4, session_id: 's1', snippet: 'remember this', score: 0.75, ts: 42 }];
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        Response.json(hits),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(remoteSearch(target, 'spaces & symbols', 7)).resolves.toEqual(hits);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://neuromancer:37777/api/search?q=spaces+%26+symbols&limit=7');
    expect(init?.headers).toEqual({ authorization: 'Bearer test-token' });
  });

  it('probes unauthenticated health before authenticated state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('ok'))
      .mockResolvedValueOnce(Response.json({ observations: 3 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeRemote(target)).resolves.toEqual({ healthz: true, auth: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://neuromancer:37777/healthz');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://neuromancer:37777/api/state');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: 'Bearer test-token',
    });
  });

  it('reports an authentication failure without hiding healthy reachability', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('ok'))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeRemote(target)).resolves.toEqual({
      healthz: true,
      auth: false,
      error: 'api/state 401',
    });
  });
});
