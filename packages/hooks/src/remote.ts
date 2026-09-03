import type { Settings } from '@cavemem/config';
import type { HookInput, HookName, HookResult } from './types.js';

export interface RemoteTarget {
  url: string;
  token: string | undefined;
  timeoutMs: number;
}

export class RemoteAuthError extends Error {
  constructor(message = 'remote worker rejected the bearer token (401)') {
    super(message);
    this.name = 'RemoteAuthError';
  }
}

/** Null in local mode. Trailing slash stripped so path joins are predictable. */
export function remoteTarget(settings: Settings): RemoteTarget | null {
  const url = settings.remote.url;
  if (!url) return null;
  return {
    url: url.replace(/\/+$/, ''),
    token: settings.remote.token,
    timeoutMs: settings.remote.timeoutMs,
  };
}

/**
 * One POST, one deadline. Throws RemoteAuthError on 401 (caller must not
 * spool — replay would fail identically), a plain Error for anything else.
 */
export async function postHook(
  target: RemoteTarget,
  name: HookName,
  input: HookInput,
  fetchImpl: typeof fetch = fetch,
): Promise<HookResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), target.timeoutMs);
  try {
    const res = await fetchImpl(`${target.url}/api/hooks/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.token ?? ''}`,
      },
      body: JSON.stringify(input),
      signal: ac.signal,
    });
    if (res.status === 401) throw new RemoteAuthError();
    if (!res.ok) throw new Error(`remote worker returned ${res.status}`);
    return (await res.json()) as HookResult;
  } finally {
    clearTimeout(timer);
  }
}
