import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from '../src/index.js';

let dir: string;
let store!: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-stop-'));
});

afterEach(() => {
  store?.close();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function mkStore(logLevel: 'debug' | 'info'): MemoryStore {
  return new MemoryStore({
    dbPath: join(dir, 'data.db'),
    settings: { ...defaultSettings, logLevel },
  });
}

describe('stop handler — missing summary', () => {
  it('logs a dropped missing-summary JSON line at debug level and stores nothing', async () => {
    store = mkStore('debug');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await runHook('stop', { session_id: 'sess-stop-d', ide: 'claude-code' }, { store });
    expect(r.ok).toBe(true);
    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(err.mock.calls[0]?.[0])) as {
      hook: string;
      dropped: string;
      session_id: string;
    };
    expect(line).toEqual({
      hook: 'stop',
      dropped: 'missing-summary',
      session_id: 'sess-stop-d',
    });
    expect(store.storage.listSummaries('sess-stop-d')).toHaveLength(0);
  });

  it('writes nothing to stderr at info level', async () => {
    store = mkStore('info');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await runHook('stop', { session_id: 'sess-stop-i', ide: 'claude-code' }, { store });
    expect(r.ok).toBe(true);
    expect(err).not.toHaveBeenCalled();
    expect(store.storage.listSummaries('sess-stop-i')).toHaveLength(0);
  });

  it('an empty-string summary counts as missing', async () => {
    store = mkStore('debug');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runHook(
      'stop',
      { session_id: 'sess-stop-e', ide: 'claude-code', turn_summary: '   ' },
      { store },
    );
    expect(err).toHaveBeenCalledTimes(1);
    expect(store.storage.listSummaries('sess-stop-e')).toHaveLength(0);
  });
});

describe('stop handler — with summary', () => {
  it('stores the turn summary and stays quiet on stderr', async () => {
    store = mkStore('debug');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runHook('session-start', { session_id: 'sess-stop-s', ide: 'claude-code' }, { store });
    const r = await runHook(
      'stop',
      { session_id: 'sess-stop-s', ide: 'claude-code', turn_summary: 'fixed the auth bug' },
      { store },
    );
    expect(r.ok).toBe(true);
    expect(err).not.toHaveBeenCalled();
    const turns = store.storage.listSummaries('sess-stop-s').filter((s) => s.scope === 'turn');
    expect(turns).toHaveLength(1);
  });
});
