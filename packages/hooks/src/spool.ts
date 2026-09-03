import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { type Settings, resolveDataDir } from '@cavemem/config';
import type { HookInput, HookName } from './types.js';

export interface SpoolEntry {
  name: HookName;
  input: HookInput;
  ts: number;
}

export const SPOOL_CAP = 500;
export const SPOOL_DRAIN_MAX = 10;

interface SpoolLock {
  fd: number;
  path: string;
}

export function spoolPath(settings: Settings): string {
  return join(resolveDataDir(settings.dataDir), 'spool.jsonl');
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

export function spoolDepth(path: string): number {
  return readLines(path).length;
}

/**
 * Append one entry. When the file exceeds `cap` lines the oldest are dropped —
 * durability is best-effort by design (spec: dropped observations acceptable).
 */
export function appendSpool(path: string, entry: SpoolEntry, cap = SPOOL_CAP): void {
  mkdirSync(dirname(path), { recursive: true });
  const lock = tryAcquireLock(path);
  if (!lock) throw new Error('spool is busy');
  try {
    const line = `${JSON.stringify(entry)}\n`;
    const existing = readLines(path);
    if (existing.length + 1 > cap) {
      const kept = existing.slice(existing.length + 1 - cap);
      writeFileSync(path, `${kept.join('\n')}\n${line}`, 'utf8');
      return;
    }
    appendFileSync(path, line, 'utf8');
  } finally {
    releaseLock(lock);
  }
}

/**
 * Replay up to `max` entries oldest-first. Stops at the first `send` failure
 * and rewrites the file with whatever was not sent. Returns the count sent.
 */
export async function drainSpool(
  path: string,
  send: (entry: SpoolEntry) => Promise<void>,
  max = SPOOL_DRAIN_MAX,
): Promise<number> {
  if (!existsSync(path)) return 0;
  const lock = tryAcquireLock(path);
  if (!lock) return 0;
  try {
    const lines = readLines(path);
    if (lines.length === 0) return 0;
    let processed = 0;
    let sent = 0;
    for (const line of lines.slice(0, max)) {
      let entry: SpoolEntry;
      try {
        entry = JSON.parse(line) as SpoolEntry;
      } catch {
        processed++;
        logMalformedEntry();
        continue;
      }
      try {
        await send(entry);
        processed++;
        sent++;
      } catch {
        break;
      }
    }
    if (processed > 0) {
      const remaining = lines.slice(processed);
      writeFileSync(path, remaining.length ? `${remaining.join('\n')}\n` : '', 'utf8');
    }
    return sent;
  } finally {
    releaseLock(lock);
  }
}

function tryAcquireLock(spool: string): SpoolLock | null {
  mkdirSync(dirname(spool), { recursive: true });
  const path = `${spool}.lock`;
  let staleChecked = false;
  while (true) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n`, 'utf8');
      } catch (err) {
        closeSync(fd);
        try {
          unlinkSync(path);
        } catch {
          // Best-effort cleanup; the original lock-write error is authoritative.
        }
        throw err;
      }
      return { fd, path };
    } catch (err) {
      if (!hasCode(err, 'EEXIST')) throw err;
      if (staleChecked || !removeDeadProcessLock(path)) return null;
      staleChecked = true;
    }
  }
}

function removeDeadProcessLock(path: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(path, 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    if (!hasCode(err, 'ESRCH')) return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    return hasCode(err, 'ENOENT');
  }
}

function releaseLock(lock: SpoolLock): void {
  try {
    closeSync(lock.fd);
  } finally {
    try {
      unlinkSync(lock.path);
    } catch {
      // Fail open. The owning CLI process is short-lived; a later process can
      // reclaim the lock after this PID exits.
    }
  }
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}

function logMalformedEntry(): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        remote: true,
        spool: true,
        ok: false,
        reason: 'malformed',
        error: 'invalid JSON in spool; entry discarded',
      })}\n`,
    );
  } catch {
    // Logging must not wedge or preserve a malformed queue entry.
  }
}
