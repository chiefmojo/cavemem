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

import { registerInstallCommand } from '../src/commands/install.js';

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
