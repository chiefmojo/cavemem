import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let dir: string;
let originalHome: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-cli-config-'));
  originalHome = process.env.CAVEMEM_HOME;
  process.env.CAVEMEM_HOME = dir;
  vi.resetModules();
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.CAVEMEM_HOME;
  else process.env.CAVEMEM_HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('config unset', () => {
  it('removes an optional key (remote.url) entirely from the file', async () => {
    writeSettings({
      remote: { url: 'http://neuromancer:37777', token: 'test-token', timeoutMs: 1500 },
    });
    const out = await runCommand(['config', 'unset', 'remote.url']);

    expect(out).toContain('✓');
    expect(out).toContain('removed remote.url');
    expect(process.exitCode).toBeUndefined();

    const settings = reread();
    expect(settings.remote.url).toBeUndefined();
    expect(settings.remote.token).toBe('test-token');
  });

  it('reverts a defaulted key to its schema default', async () => {
    writeSettings({ workerPort: 40000 });
    const out = await runCommand(['config', 'unset', 'workerPort']);

    expect(out).toContain('reverted workerPort to default: 37777');
    expect(process.exitCode).toBeUndefined();

    const settings = reread();
    expect(settings.workerPort).toBe(37777);
  });

  it('reverts dataDir to the auto-resolved home and keeps it out of the file', async () => {
    writeSettings({ dataDir: '/tmp/somewhere-else' });
    const out = await runCommand(['config', 'unset', 'dataDir']);

    expect(out).toContain(
      `reverted dataDir to auto-resolved home: ${JSON.stringify(resolve(dir))}`,
    );
    expect(process.exitCode).toBeUndefined();

    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect('dataDir' in raw).toBe(false);
    // loadSettings re-resolves dataDir via the schema default.
    const { loadSettings } = await import('@cavemem/config');
    expect(loadSettings().dataDir).toBe(resolve(dir));
  });

  it('no-op-succeeds on a known schema key that is already absent', async () => {
    // Rollback-runbook case: remote.token is optional and may never have
    // been written to settings.json (e.g. tokenless worker on a trusted
    // LAN). unset must not treat that as an error and abort a
    // `&&`-chained runbook.
    writeSettings({ remote: { url: 'http://neuromancer:37777', timeoutMs: 1500 } });
    const out = await runCommand(['config', 'unset', 'remote.token']);

    expect(out).toContain('already unset: remote.token');
    expect(process.exitCode).toBeUndefined();

    // Untouched settings stay exactly as they were.
    const settings = reread();
    expect(settings.remote.url).toBe('http://neuromancer:37777');
  });

  it('errors on an unknown key with exit code 1', async () => {
    writeSettings();
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });

    const out = await runCommand(['config', 'unset', 'no.such.key']);

    expect(out).toBe('');
    expect(err.join('')).toContain('unknown key: no.such.key');
    expect(process.exitCode).toBe(1);
  });

  it('unsetting the whole remote block refills its default', async () => {
    writeSettings({
      remote: { url: 'http://neuromancer:37777', token: 't', timeoutMs: 1500 },
    });
    const out = await runCommand(['config', 'unset', 'remote']);

    expect(out).toContain('reverted remote to default: {"timeoutMs":1500}');

    const settings = reread();
    expect(settings.remote.url).toBeUndefined();
    expect(settings.remote.timeoutMs).toBe(1500);
  });
});

async function runCommand(args: string[]): Promise<string> {
  const { createProgram } = await import('../src/index.js');
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  await createProgram().parseAsync(args, { from: 'user' });
  return out;
}

function reread(): {
  dataDir: string;
  workerPort: number;
  remote: { url?: string; token?: string; timeoutMs: number };
} {
  return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
}

function writeSettings(overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(overrides)}\n`);
}
