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

export class RemotePermanentError extends Error {
  constructor(status: number) {
    super(`remote worker returned ${status}`);
    this.name = 'RemotePermanentError';
  }
}

/** Null in local mode. Remote targets are canonical central-worker base URLs. */
export function remoteTarget(settings: Settings): RemoteTarget | null {
  const url = settings.remote.url;
  if (!url) return null;
  return {
    url: canonicalRemoteUrl(url),
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
  const endpoint = new URL(`api/hooks/${name}`, `${canonicalRemoteUrl(target.url)}/`).href;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), target.timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.token ?? ''}`,
      },
      body: JSON.stringify(input),
      signal: ac.signal,
    });
    if (res.status === 401) throw new RemoteAuthError();
    if (res.status >= 400 && res.status < 500) throw new RemotePermanentError(res.status);
    if (!res.ok) throw new Error(`remote worker returned ${res.status}`);
    return (await res.json()) as HookResult;
  } finally {
    clearTimeout(timer);
  }
}

function canonicalRemoteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidRemoteUrl();
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw invalidRemoteUrl();
  }
  return url.origin;
}

function invalidRemoteUrl(): Error {
  return new Error(
    'remote.url must be an http(s) central-worker base URL with no path, query, or fragment',
  );
}
