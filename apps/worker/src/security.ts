import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Settings } from '@cavemem/config';
import { workerTokenPath } from '@cavemem/config';
import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

/**
 * The worker binds to 127.0.0.1 by default; remote mode binds 0.0.0.0 and
 * relies on the same three layers with `workerAllowedHosts` widening layer 1
 * and 2. That alone doesn't stop (a) a malicious web page doing a
 * CSRF/DNS-rebinding fetch to 127.0.0.1:<port>, or (b) another local
 * user/process on the same machine. Three layers:
 *   1. Host header allowlist — kills DNS rebinding.
 *   2. Origin header check — kills browser-page CSRF (no CORS headers added).
 *   3. Bearer token (viewer HTML: cookie handshake instead) — kills
 *      same-origin-but-unauthenticated access.
 */

export function tokenFilePath(settings: Settings): string {
  return workerTokenPath(settings.dataDir);
}

/** Reuse the token across restarts; generate + persist (mode 0600) on first run. */
export function getOrCreateToken(settings: Settings): string {
  const path = tokenFilePath(settings);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  // mode here narrows perms at creation time (umask can still widen it);
  // chmod afterward guarantees 0600 regardless of umask.
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort — e.g. no posix perms on this platform.
  }
  return token;
}

/**
 * Loopback is always accepted so on-box tooling keeps working; `extra`
 * (settings.workerAllowedHosts) adds the names LAN clients will use. The
 * union is the whole trust boundary once workerHost is 0.0.0.0 — the bearer
 * token still gates /api/* and /mcp, but Host/Origin are what stop DNS
 * rebinding and browser CSRF.
 */
export function allowedHostSet(port: number, extra: string[]): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...extra]);
}

export function hostAllowlist(allowed: Set<string>): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host');
    if (!host || !allowed.has(host)) {
      return c.text('Forbidden', 403);
    }
    await next();
  };
}

export function originCheck(allowed: Set<string>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin) {
      let ok = false;
      for (const h of allowed) {
        if (origin === `http://${h}`) {
          ok = true;
          break;
        }
      }
      if (!ok) return c.text('Forbidden', 403);
    }
    await next();
  };
}

function tokenMatches(token: string, supplied: string | undefined): boolean {
  const actual = Buffer.from(token);
  const candidate = Buffer.from(supplied ?? '');
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const supplied = bearer ?? c.req.header('x-cavemem-token');
    if (!tokenMatches(token, supplied)) {
      return c.text('Unauthorized', 401);
    }
    await next();
  };
}

export const VIEWER_COOKIE = 'cavemem_viewer';
const VIEWER_SESSION_TTL_MS = 2 * 60 * 1000;

/**
 * Single-use, short-lived nonces that stand in for the real bearer token in
 * the viewer handshake URL. Putting the *actual* worker-token in a URL means
 * it lands in a spawned opener's argv (`ps`/`/proc/<pid>/cmdline` — readable
 * by any local user, not just the one who ran `cavemem viewer`) and in
 * browser history. A nonce is worthless once consumed or expired, so either
 * exposure only leaks something already dead. In-memory only: worth nothing
 * once the worker restarts, and there's no reason to persist a one-shot.
 */
export function createViewerSessionStore() {
  const nonces = new Map<string, number>();
  const prune = (now: number) => {
    for (const [n, exp] of nonces) if (exp <= now) nonces.delete(n);
  };
  return {
    mint(): string {
      const now = Date.now();
      prune(now);
      const nonce = randomBytes(24).toString('hex');
      nonces.set(nonce, now + VIEWER_SESSION_TTL_MS);
      return nonce;
    },
    /** Consumes the nonce regardless of outcome — single-use either way. */
    consume(nonce: string): boolean {
      const exp = nonces.get(nonce);
      nonces.delete(nonce);
      return exp !== undefined && exp > Date.now();
    },
  };
}

export type ViewerSessionStore = ReturnType<typeof createViewerSessionStore>;

/**
 * HTML routes can't carry an Authorization header on a top-level browser
 * navigation, so the viewer bootstraps once with a one-time `?token=` nonce
 * (minted via POST /api/viewer-session, bearer-protected like the rest of
 * /api/*), trades it for a session cookie, and redirects to the same path
 * with the nonce stripped — it never sits in the URL bar or browser history
 * past that first hop, and the argv a spawned browser opener receives is
 * likewise already-spent.
 *
 * Cookie auth is scoped to this middleware only; /api/* and /mcp stay on
 * bearerAuth, so a viewer tab's cookie can never be replayed against the
 * write path. `SameSite=Strict` plus the existing Origin check (originCheck,
 * applied to every route ahead of this one) closes the usual CSRF hole a
 * cookie would otherwise reopen. No `secure` flag: the worker is plain HTTP
 * by design (docs/remote.md — no TLS). No `maxAge`: session-only, so the
 * credential never touches disk in the browser either.
 */
export function viewerAuth(token: string, sessions: ViewerSessionStore): MiddlewareHandler {
  return async (c, next) => {
    const supplied = c.req.query('token');
    if (supplied !== undefined) {
      if (!sessions.consume(supplied)) return c.text('Unauthorized', 401);
      setCookie(c, VIEWER_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
      });
      const url = new URL(c.req.url);
      url.searchParams.delete('token');
      return c.redirect(`${url.pathname}${url.search}`, 302);
    }
    if (tokenMatches(token, getCookie(c, VIEWER_COOKIE))) return next();
    return bearerAuth(token)(c, next);
  };
}
