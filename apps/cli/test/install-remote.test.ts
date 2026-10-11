import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  install: vi.fn(async (_ctx: unknown) => [] as string[]),
  saveSettings: vi.fn(),
  settings: {} as Record<string, unknown>,
}));

vi.mock('@cavemem/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cavemem/config')>();
  return {
    ...actual,
    loadSettings: () => mocks.settings,
    saveSettings: mocks.saveSettings,
    settingsPath: () => '/tmp',
  };
});

vi.mock('@cavemem/installers', () => {
  const installer = {
    id: 'claude-code',
    label: 'Claude Code',
    capture: 'full',
    detect: vi.fn(async () => true),
    install: mocks.install,
    uninstall: vi.fn(async () => []),
  };
  return {
    installers: { 'claude-code': installer },
    getInstaller: () => installer,
    checkWindowsSh: () => null,
  };
});

import { formatInstallMessage, registerInstallCommand } from '../src/commands/install.js';

beforeEach(() => {
  mocks.settings = settingsWithRemote('http://neuromancer:37777');
});

afterEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('remote install', () => {
  it('rejects an invalid central-worker URL before the installer can mutate IDE config', async () => {
    mocks.settings = settingsWithRemote('http://neuromancer:37777/not-the-worker-root');

    await expect(runInstall()).rejects.toThrow(
      'remote.url must be an http(s) central-worker base URL with no path, query, or fragment',
    );

    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it('passes the canonical remote target to the installer', async () => {
    mocks.settings = settingsWithRemote('http://neuromancer:37777/');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runInstall();

    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.install.mock.calls[0]?.[0]).toMatchObject({
      remote: { url: 'http://neuromancer:37777', token: 'test-token' },
    });
  });

  it('points remote clients to the server viewer instead of the local-only viewer command', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });

    await runInstall();

    expect(out).toContain('http://neuromancer:37777');
    expect(out).toContain('remote memory viewer');
    expect(out).not.toContain('cavemem viewer');
  });
});

describe('install output', () => {
  function capture(): () => string {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    return () => out;
  }

  it('renders installer warnings as warnings, not with the success mark', async () => {
    mocks.install.mockResolvedValueOnce(['wrote /x/opencode.json', 'warning: something is off']);
    const out = capture();

    await runInstall();

    const lines = out().split('\n');
    expect(lines.find((l) => l.includes('wrote /x/opencode.json'))).toContain('✓');
    const warning = lines.find((l) => l.includes('something is off'));
    expect(warning).toContain('warning: something is off');
    expect(warning).not.toContain('✓');
  });

  it('formatInstallMessage marks only non-warning lines with the success mark', () => {
    expect(formatInstallMessage('wrote /x')).toContain('✓');
    expect(formatInstallMessage('warning: careful')).not.toContain('✓');
    expect(formatInstallMessage('warning: careful')).toContain('warning: careful');
  });

  it('does not claim local model weights will download on a remote-mode client', async () => {
    mocks.settings = {
      ...settingsWithRemote('http://neuromancer:37777'),
      embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2' },
    };
    const out = capture();

    await runInstall();

    expect(out()).toContain('embeddings: computed on the server');
    expect(out()).not.toContain('weights (~25 MB)');
    expect(out()).not.toContain('/models');
    expect(out()).not.toContain('Xenova/all-MiniLM-L6-v2');
  });

  it('still reports the local embedding model download on a local-mode install', async () => {
    mocks.settings = {
      dataDir: '/tmp/cavemem-install-local-test',
      remote: { url: '', token: '', timeoutMs: 1500 },
      ides: {},
      embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2' },
    };
    const out = capture();

    await runInstall();

    expect(out()).toContain('embeddings: local Xenova/all-MiniLM-L6-v2');
    expect(out()).toContain('/tmp/cavemem-install-local-test/models');
    expect(out()).not.toContain('computed on the server');
  });
});

async function runInstall(): Promise<void> {
  const program = new Command();
  registerInstallCommand(program);
  await program.parseAsync(['install', '--ide', 'claude-code'], { from: 'user' });
}

function settingsWithRemote(url: string): Record<string, unknown> {
  return {
    dataDir: '/tmp/cavemem-install-remote-test',
    remote: { url, token: 'test-token', timeoutMs: 1500 },
    ides: {},
    embedding: { provider: 'none', model: 'unused' },
  };
}
