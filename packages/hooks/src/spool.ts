import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Settings, resolveDataDir } from '@cavemem/config';
import type { HookInput, HookName } from './types.js';

export interface SpoolEntry {
  name: HookName;
  input: HookInput;
  ts: number;
}

export const SPOOL_CAP = 500;
export const SPOOL_DRAIN_MAX = 10;

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
  const line = `${JSON.stringify(entry)}\n`;
  const existing = readLines(path);
  if (existing.length + 1 > cap) {
    const kept = existing.slice(existing.length + 1 - cap);
    writeFileSync(path, `${kept.join('\n')}\n${line}`, 'utf8');
    return;
  }
  appendFileSync(path, line, 'utf8');
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
  const lines = readLines(path);
  if (lines.length === 0) return 0;
  let sent = 0;
  for (const line of lines.slice(0, max)) {
    let entry: SpoolEntry;
    try {
      entry = JSON.parse(line) as SpoolEntry;
    } catch {
      sent++; // malformed line: discard rather than wedge the queue
      continue;
    }
    try {
      await send(entry);
      sent++;
    } catch {
      break;
    }
  }
  const remaining = lines.slice(sent);
  writeFileSync(path, remaining.length ? `${remaining.join('\n')}\n` : '', 'utf8');
  return sent;
}
