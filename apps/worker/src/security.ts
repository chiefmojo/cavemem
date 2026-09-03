import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Settings } from '@cavemem/config';
import { resolveDataDir } from '@cavemem/config';
import type { MiddlewareHandler } from 'hono';

/**
 * The worker binds to 127.0.0.1 by default; remote mode binds 0.0.0.0 and
 * relies on the same three layers with `workerAllowedHosts` widening layer 1
 * and 2. That alone doesn't stop (a) a malicious web page doing a
 * CSRF/DNS-rebinding fetch to 127.0.0.1:<port>, or (b) another local
 * user/process on the same machine. Three layers:
 *   1. Host header allowlist — kills DNS rebinding.
 *   2. Origin header check — kills browser-page CSRF (no CORS headers added).
 *   3. Bearer token on /api/* — kills same-origin-but-unauthenticated access.
 */

export function tokenFilePath(settings: Settings): string {
  return join(resolveDataDir(settings.dataDir), 'worker-token');
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

export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const supplied = bearer ?? c.req.header('x-cavemem-token');
    const actual = Buffer.from(token);
    const candidate = Buffer.from(supplied ?? '');
    if (actual.length !== candidate.length || !timingSafeEqual(actual, candidate)) {
      return c.text('Unauthorized', 401);
    }
    await next();
  };
}
