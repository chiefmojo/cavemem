import type { SearchResult } from '@cavemem/core';
import type { RemoteTarget } from '@cavemem/hooks';

function headers(target: RemoteTarget): Record<string, string> {
  return { authorization: `Bearer ${target.token ?? ''}` };
}

export async function remoteSearch(
  target: RemoteTarget,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const u = new URL(`${target.url}/api/search`);
  u.searchParams.set('q', query);
  u.searchParams.set('limit', String(limit));
  const res = await fetch(u, {
    headers: headers(target),
    signal: AbortSignal.timeout(target.timeoutMs * 4),
  });
  if (!res.ok) throw new Error(`remote search failed: ${res.status}`);
  return (await res.json()) as SearchResult[];
}

export async function probeRemote(
  target: RemoteTarget,
): Promise<{ healthz: boolean; auth: boolean; error?: string }> {
  try {
    const h = await fetch(`${target.url}/healthz`, {
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    if (!h.ok) return { healthz: false, auth: false, error: `healthz ${h.status}` };
    const a = await fetch(`${target.url}/api/state`, {
      headers: headers(target),
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    return {
      healthz: true,
      auth: a.ok,
      ...(a.ok ? {} : { error: `api/state ${a.status}` }),
    };
  } catch (err) {
    return {
      healthz: false,
      auth: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
