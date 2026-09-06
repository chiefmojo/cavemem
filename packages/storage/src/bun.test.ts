import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, unlinkSync } from 'node:fs';
import { Storage } from './storage.js';

const DB_PATH = '/tmp/cavemem-bun-test.db';

let storage: Storage;

const SESSION_ID = 'test-session-bun-001';

beforeAll(() => {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  storage = new Storage(DB_PATH);
  // observations/summaries reference sessions via a foreign key —
  // bun:sqlite enforces it (PRAGMA foreign_keys = ON in SCHEMA_SQL), so the
  // parent row must exist before inserting children.
  storage.createSession({
    id: SESSION_ID,
    ide: 'test',
    cwd: null,
    started_at: Date.now(),
    metadata: null,
  });
});

afterAll(() => {
  storage.close();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

describe('Storage (bun:sqlite backend)', () => {
  it('inserts and counts observations', () => {
    const id = storage.insertObservation({
      session_id: SESSION_ID,
      kind: 'user',
      content: 'hello bun sqlite',
      compressed: false,
      intensity: null,
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    expect(storage.countObservations()).toBeGreaterThanOrEqual(1);
  });

  it('retrieves observations for a session', () => {
    const obs = storage.timeline(SESSION_ID);
    expect(obs.length).toBeGreaterThanOrEqual(1);
    expect(obs[0].session_id).toBe(SESSION_ID);
    expect(obs[0].content).toBe('hello bun sqlite');
    expect(obs[0].kind).toBe('user');
  });

  it('inserts and lists summaries', () => {
    const id = storage.insertSummary({
      session_id: SESSION_ID,
      scope: 'turn',
      content: 'summary text',
      compressed: false,
      intensity: null,
    });
    expect(typeof id).toBe('number');
    const summaries = storage.listSummaries(SESSION_ID);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries[0].content).toBe('summary text');
  });

  it('lists sessions containing observations', () => {
    const sessions = storage.listSessions();
    const found = sessions.some((s) => s.id === SESSION_ID);
    expect(found).toBe(true);
  });

  it('listSessions accepts a cwd filter and returns only that cwd in recency order', () => {
    // Explicit started_at values keep ORDER BY started_at DESC deterministic.
    const base = Date.now() + 10_000; // after any session created by earlier tests
    storage.createSession({
      id: 'cwd-a-old',
      ide: 'test',
      cwd: '/proj/a',
      started_at: base,
      metadata: null,
    });
    storage.createSession({
      id: 'cwd-b-1',
      ide: 'test',
      cwd: '/proj/b',
      started_at: base + 1,
      metadata: null,
    });
    storage.createSession({
      id: 'cwd-b-2',
      ide: 'test',
      cwd: '/proj/b',
      started_at: base + 2,
      metadata: null,
    });
    storage.createSession({
      id: 'cwd-a-new',
      ide: 'test',
      cwd: '/proj/a',
      started_at: base + 3,
      metadata: null,
    });

    const a = storage.listSessions(10, { cwd: '/proj/a' });
    expect(a.map((s) => s.id)).toEqual(['cwd-a-new', 'cwd-a-old']);
  });

  it('supports readonly mode: reads existing data and rejects writes', () => {
    const ro = new Storage(DB_PATH, { readonly: true });
    expect(ro.countObservations()).toBeGreaterThan(0);
    expect(() =>
      ro.insertObservation({
        session_id: SESSION_ID,
        kind: 'user',
        content: 'should not be writable',
        compressed: false,
        intensity: null,
      }),
    ).toThrow();
    ro.close();
  });
});
