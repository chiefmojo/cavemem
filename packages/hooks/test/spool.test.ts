import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SpoolEntry, appendSpool, drainSpool, spoolDepth } from '../src/spool.js';

let dir: string;
let path: string;

const entry = (n: number): SpoolEntry => ({
  name: 'user-prompt-submit',
  input: { session_id: 's', prompt: `p${n}` },
  ts: n,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-spool-'));
  path = join(dir, 'spool.jsonl');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('spool', () => {
  it('appends one JSON line per entry', () => {
    appendSpool(path, entry(1));
    appendSpool(path, entry(2));
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(spoolDepth(path)).toBe(2);
  });

  it('caps the file by dropping the oldest lines', () => {
    for (let i = 0; i < 7; i++) appendSpool(path, entry(i), 5);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    expect((JSON.parse(lines[0] ?? '{}') as SpoolEntry).ts).toBe(2);
  });

  it('creates a missing spool parent before the first append', () => {
    path = join(dir, 'custom', 'nested', 'spool.jsonl');
    appendSpool(path, entry(1));
    expect(existsSync(path)).toBe(true);
    expect(spoolDepth(path)).toBe(1);
  });

  it('drains oldest-first up to max and leaves the rest', async () => {
    for (let i = 0; i < 4; i++) appendSpool(path, entry(i));
    const sent: number[] = [];
    const n = await drainSpool(
      path,
      async (e) => {
        sent.push(e.ts);
      },
      3,
    );
    expect(n).toBe(3);
    expect(sent).toEqual([0, 1, 2]);
    expect(spoolDepth(path)).toBe(1);
  });

  it('stops at the first failure and keeps the remainder', async () => {
    for (let i = 0; i < 3; i++) appendSpool(path, entry(i));
    const n = await drainSpool(path, async (e) => {
      if (e.ts === 1) throw new Error('down');
    });
    expect(n).toBe(1);
    expect(spoolDepth(path)).toBe(2);
  });

  it('coordinates overlapping drains without duplicate replay or lost rewrites', async () => {
    appendSpool(path, entry(0));
    let markStarted: (() => void) | undefined;
    let releaseSend: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sent: number[] = [];
    const first = drainSpool(path, async (e) => {
      sent.push(e.ts);
      markStarted?.();
      await released;
    });
    await started;

    const second = await drainSpool(path, async (e) => {
      sent.push(e.ts);
    });
    let appendContended = false;
    try {
      appendSpool(path, entry(1));
    } catch {
      appendContended = true;
    }
    releaseSend?.();
    const firstCount = await first;

    expect(firstCount).toBe(1);
    expect(second).toBe(0);
    expect(appendContended).toBe(true);
    expect(sent).toEqual([0]);
    expect(spoolDepth(path)).toBe(0);

    appendSpool(path, entry(1));
    expect(spoolDepth(path)).toBe(1);
  });

  it('does not reclaim a pre-existing lock and leaves the queue unchanged', async () => {
    appendSpool(path, entry(0));
    writeFileSync(`${path}.lock`, '999999999\n', 'utf8');
    const logs: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      logs.push(String(chunk));
      return true;
    });
    const sent: number[] = [];

    const drained = await drainSpool(path, async (e) => {
      sent.push(e.ts);
    });
    let appendContended = false;
    try {
      appendSpool(path, entry(1));
    } catch {
      appendContended = true;
    }

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(drained).toBe(0);
    expect(sent).toEqual([]);
    expect(appendContended).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(true);
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '{}') as SpoolEntry).ts).toBe(0);
    expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ spool: true, ok: false, reason: 'locked' }),
    );
  });

  it('logs and discards malformed JSON without counting it as sent', async () => {
    writeFileSync(path, `{not-json}\n${JSON.stringify(entry(1))}\n`, 'utf8');
    const logs: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      logs.push(String(chunk));
      return true;
    });
    const sent: number[] = [];
    const n = await drainSpool(path, async (e) => {
      sent.push(e.ts);
    });

    expect(n).toBe(1);
    expect(sent).toEqual([1]);
    expect(spoolDepth(path)).toBe(0);
    expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ spool: true, ok: false, reason: 'malformed' }),
    );
  });

  it('depth is 0 when the file does not exist', () => {
    expect(spoolDepth(path)).toBe(0);
  });
});
