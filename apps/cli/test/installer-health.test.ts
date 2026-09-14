import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, saveSettings } from '@cavemem/config';
import { Storage } from '@cavemem/storage';
import { Command } from 'commander';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerDoctorCommand } from '../src/commands/doctor.js';
import { registerInstallCommand } from '../src/commands/install.js';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => state.home,
}));
vi.mock('@cavemem/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cavemem/config')>();
  const settingsPath = () => join(state.home, 'data/settings.json');
  return {
    ...actual,
    settingsPath,
    loadSettings: () => actual.loadSettings(settingsPath()),
    saveSettings: (settings: Parameters<typeof actual.saveSettings>[0]) =>
      actual.saveSettings(settings, settingsPath()),
  };
});
let out: string;
beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), 'cavemem-health-'));
  vi.stubEnv('CAVEMEM_HOME', join(state.home, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(state.home, '.config'));
  vi.stubEnv('APPDATA', join(state.home, 'AppData/Roaming'));
  mkdirSync(join(state.home, 'bin'));
  symlinkSync(
    process.execPath,
    join(state.home, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  vi.stubEnv('PATH', join(state.home, 'bin'));
  saveSettings({
    ...defaultSettings,
    dataDir: join(state.home, 'data'),
    embedding: { ...defaultSettings.embedding, provider: 'none' },
    ides: {},
  });
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(state.home, { recursive: true, force: true });
});

async function run(command: 'install' | 'doctor', ...args: string[]): Promise<void> {
  const program = new Command();
  registerInstallCommand(program);
  registerDoctorCommand(program);
  await program.parseAsync([command, ...args], { from: 'user' });
}

it('persists the stable PATH Node through the CLI installer boundary', async () => {
  await run('install', '--ide', 'cursor');
  const config = JSON.parse(readFileSync(join(state.home, '.cursor/mcp.json'), 'utf8'));
  expect(config.mcpServers.cavemem.command).toBe(
    join(state.home, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
});

it.each([false, true])(
  'doctor reports installer repair in remote=%s without mutating IDE config',
  async (remote) => {
    saveSettings({
      ...defaultSettings,
      dataDir: join(state.home, 'data'),
      ides: { cursor: true },
      ...(remote
        ? { remote: { url: 'http://localhost:37777', token: 'secret-token', timeoutMs: 1000 } }
        : {}),
    });
    mkdirSync(join(state.home, '.cursor'));
    const configPath = join(state.home, '.cursor/mcp.json');
    const config = JSON.stringify({
      mcpServers: {
        cavemem: {
          command: join(state.home, 'deleted/node'),
          args: ['cli.js', 'mcp'],
          env: { TOKEN: 'secret-token' },
        },
      },
    });
    writeFileSync(configPath, config);
    if (remote)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({})),
      );
    await run('doctor');
    expect(out).toContain('cursor');
    expect(out).toContain('cavemem install --ide cursor');
    expect(out).not.toContain('secret-token');
    expect(process.exitCode).toBe(1);
    expect(readFileSync(configPath, 'utf8')).toBe(config);
    vi.unstubAllGlobals();
  },
);

it('doctor does not create a missing database', async () => {
  await run('doctor');
  expect(existsSync(join(state.home, 'data/data.db'))).toBe(false);
  expect(out).toContain('none yet (no sessions captured)');
  expect(process.exitCode).toBeUndefined();
});

it('doctor reports an out-of-date database schema with a repair command', async () => {
  const path = join(state.home, 'data/data.db');
  mkdirSync(join(state.home, 'data'), { recursive: true });
  writeFileSync(path, '');

  await run('doctor');

  expect(out).toContain('schema out of date');
  expect(out).toContain('cavemem reindex');
  expect(out).not.toContain('no such table');
  expect(process.exitCode).toBe(1);
});

it('doctor treats an existing Homebrew Cellar interpreter as advisory', async () => {
  const node = join(state.home, 'Cellar/node/24.1.0/bin/node');
  mkdirSync(join(state.home, 'Cellar/node/24.1.0/bin'), { recursive: true });
  writeFileSync(node, '', { mode: 0o755 });
  mkdirSync(join(state.home, '.cursor'), { recursive: true });
  writeFileSync(
    join(state.home, '.cursor/mcp.json'),
    JSON.stringify({ mcpServers: { cavemem: { command: node, args: ['cli.js', 'mcp'] } } }),
  );
  saveSettings({
    ...defaultSettings,
    dataDir: join(state.home, 'data'),
    embedding: { ...defaultSettings.embedding, provider: 'none' },
    ides: { cursor: true },
  });

  await run('doctor');

  expect(out).toContain('pinned to a Homebrew Cellar version');
  expect(out).toContain('cavemem install --ide cursor');
  expect(process.exitCode).toBeUndefined();
});

it('doctor leaves existing database contents unchanged', async () => {
  const path = join(state.home, 'data/data.db');
  const storage = new Storage(path);
  storage.close();
  const before = readFileSync(path);
  await run('doctor');
  expect(readFileSync(path)).toEqual(before);
});
