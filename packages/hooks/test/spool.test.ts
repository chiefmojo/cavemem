import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('depth is 0 when the file does not exist', () => {
    expect(spoolDepth(path)).toBe(0);
  });
});
