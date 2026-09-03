import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({
  mcp: vi.fn(),
  spawn: vi.fn(() => {
    throw new Error('local spawn reached');
  }),
  storage: vi.fn(() => {
    throw new Error('local storage reached');
  }),
  worker: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: boundaries.spawn,
}));

vi.mock('@cavemem/storage', () => ({
  Storage: class {
    constructor() {
      boundaries.storage();
    }
  },
}));

vi.mock('@cavemem/worker', () => ({ start: boundaries.worker }));
vi.mock('@cavemem/mcp-server', () => ({ main: boundaries.mcp }));

let dir: string;
let originalHome: string | undefined;
let originalCodexToken: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-cli-remote-'));
  originalHome = process.env.CAVEMEM_HOME;
  originalCodexToken = process.env.CAVEMEM_REMOTE_TOKEN;
  process.env.CAVEMEM_HOME = dir;
  vi.resetModules();
});

beforeEach(() => {
  rmSync(join(dir, 'data.db'), { force: true });
  rmSync(join(dir, 'worker.pid'), { force: true });
  rmSync(join(dir, 'spool.jsonl'), { force: true });
  writeSettings();
});

afterEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalCodexToken === undefined) delete process.env.CAVEMEM_REMOTE_TOKEN;
  else process.env.CAVEMEM_REMOTE_TOKEN = originalCodexToken;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.CAVEMEM_HOME;
  else process.env.CAVEMEM_HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('remote CLI commands', () => {
  it('status reports auth failure and spool depth without opening a local database', async () => {
    writeFileSync(join(dir, 'spool.jsonl'), '{}\n{}\n');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('ok'))
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 })),
    );
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });

    await runCommand(['status']);

    expect(out).toContain('mode:       remote http://neuromancer:37777');
    expect(out).toContain('server:     reachable auth failed (api/state 401)');
    expect(out).toContain('spool:      2 queued');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(dir, 'data.db'))).toBe(false);
  });

  it('doctor reports Codex auth, spool state, and actionable local-worker cleanup', async () => {
    writeSettings({ ides: { codex: true } });
    writeFileSync(join(dir, 'spool.jsonl'), '{}\n');
    writeFileSync(join(dir, 'worker.pid'), '12345\n');
    delete process.env.CAVEMEM_REMOTE_TOKEN;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('ok'))
        .mockResolvedValueOnce(Response.json({ observations: 3 })),
    );
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });

    await runCommand(['doctor']);

    expect(out).toContain('token:    present');
    expect(out).toContain('server:   ok');
    expect(out).toContain('auth:     ok');
    expect(out).toContain('CAVEMEM_REMOTE_TOKEN not set');
    expect(out).toContain('remove remote.url');
    expect(out).toContain('cavemem stop');
    expect(out).toContain('restore remote.url');
    expect(out).toContain('spool:    1 queued');
    expect(existsSync(join(dir, 'data.db'))).toBe(false);
  });

  it('all local-only actions refuse before touching local state', async () => {
    const errors: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    const commands = [
      ['start'],
      ['stop'],
      ['restart'],
      ['viewer'],
      ['worker', 'start'],
      ['worker', 'run'],
      ['worker', 'stop'],
      ['worker', 'status'],
      ['reindex'],
      ['export', join(dir, 'export.jsonl')],
      ['import', join(dir, 'missing.jsonl')],
      ['mcp'],
    ];

    for (const args of commands) await runCommand(args);

    expect(errors).toHaveLength(commands.length);
    for (const args of commands) {
      expect(errors.join('')).toContain(
        `run \`cavemem ${args[0]}${args[1] && args[0] === 'worker' ? ` ${args[1]}` : ''}\``,
      );
    }
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(dir, 'data.db'))).toBe(false);
    expect(existsSync(join(dir, 'worker.pid'))).toBe(false);
    expect(existsSync(join(dir, 'export.jsonl'))).toBe(false);
    expect(boundaries.spawn).not.toHaveBeenCalled();
    expect(boundaries.storage).not.toHaveBeenCalled();
    expect(boundaries.worker).not.toHaveBeenCalled();
    expect(boundaries.mcp).not.toHaveBeenCalled();
  });
});

async function runCommand(args: string[]): Promise<void> {
  const { createProgram } = await import('../src/index.js');
  await createProgram().parseAsync(args, { from: 'user' });
}

function writeSettings(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, 'settings.json'),
    `${JSON.stringify({
      dataDir: dir,
      remote: {
        url: 'http://neuromancer:37777',
        token: 'test-token',
        timeoutMs: 1500,
      },
      ...overrides,
    })}\n`,
  );
}
