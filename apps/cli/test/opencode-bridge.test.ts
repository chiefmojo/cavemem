import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookSpawnCommand, resolveNodeBinary } from '../src/opencode-bridge.js';

// Windows: spawn() cannot execute a .js file directly — uv_spawn has no exec
// handler for it and fails with EFTYPE (same failure worker.ts already guards
// against). The bridge must route .js entrypoints through a real node runtime
// — and never through process.execPath when that is the IDE's own binary
// (opencode embeds Bun, so execPath is opencode.exe inside a plugin).
const NOT_NODE = 'C:\\Program Files\\opencode\\opencode.exe';

const tempDirs: string[] = [];

function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cavemem-bridge-'));
  tempDirs.push(dir);
  return dir;
}

// Content never matters — these stubs are only stat'd/read, never executed.
function writeFakeNode(dir: string, name = 'node'): string {
  mkdirSync(dir, { recursive: true });
  const full = join(dir, name);
  writeFileSync(full, 'node stub');
  return full;
}

function writeOpencodeConfig(configDir: string, nodePath: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'opencode.json'),
    JSON.stringify({
      mcp: {
        cavemem: {
          type: 'local',
          command: [nodePath, '/cli/index.js', 'mcp'],
          enabled: true,
        },
      },
    }),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveNodeBinary', () => {
  it('returns execPath when it is node, without consulting config or PATH', () => {
    const result = resolveNodeBinary({
      execPath: '/usr/local/bin/node',
      env: {},
      homeDir: mkTemp(),
    });
    expect(result).toBe('/usr/local/bin/node');
  });

  it('returns null when execPath is the IDE binary, no config exists, and PATH is empty', () => {
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: { PATH: '' },
      homeDir: mkTemp(),
    });
    expect(result).toBeNull();
  });

  it('reads the absolute node path from opencode.json under the default config home', () => {
    const home = mkTemp();
    const fakeNode = writeFakeNode(join(home, 'runtime'));
    writeOpencodeConfig(join(home, '.config', 'opencode'), fakeNode);
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: {},
      homeDir: home,
    });
    expect(result).toBe(fakeNode);
  });

  it('falls through to a PATH scan when the configured node path does not exist', () => {
    const home = mkTemp();
    const missingNode = join(home, 'missing-runtime', 'node');
    writeOpencodeConfig(join(home, '.config', 'opencode'), missingNode);
    const pathDir = mkTemp();
    const pathNode = writeFakeNode(pathDir);
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: { PATH: pathDir },
      homeDir: home,
    });
    expect(result).toBe(pathNode);
  });

  it('honors XDG_CONFIG_HOME over the default config home', () => {
    const home = mkTemp();
    // A decoy config at the default location pointing at a missing node: if
    // XDG_CONFIG_HOME were ignored, resolution would fall through to a PATH
    // scan (no PATH injected) and return null instead.
    writeOpencodeConfig(join(home, '.config', 'opencode'), join(home, 'missing', 'node'));
    const xdg = mkTemp();
    const fakeNode = writeFakeNode(join(xdg, 'runtime'));
    writeOpencodeConfig(join(xdg, 'opencode'), fakeNode);
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: { XDG_CONFIG_HOME: xdg },
      homeDir: home,
    });
    expect(result).toBe(fakeNode);
  });

  it('on win32 searches node.exe across ;-separated PATH dirs', () => {
    const emptyDir = mkTemp();
    const nodeDir = mkTemp();
    const nodeExe = writeFakeNode(nodeDir, 'node.exe');
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: { PATH: `${emptyDir};${nodeDir}` },
      homeDir: mkTemp(),
      platform: 'win32',
    });
    expect(result).toBe(nodeExe);
  });
});

describe('hookSpawnCommand', () => {
  it('wraps .js entrypoints in the resolved node runtime', () => {
    const cli = join('C:', 'npm', 'node_modules', 'cavemem', 'dist', 'index.js');
    expect(hookSpawnCommand(cli, '/usr/local/bin/node')).toEqual({
      command: '/usr/local/bin/node',
      args: [cli],
    });
  });

  it('returns null for .js entrypoints when no node runtime resolved', () => {
    const cli = join('C:', 'npm', 'node_modules', 'cavemem', 'dist', 'index.js');
    expect(hookSpawnCommand(cli, null)).toBeNull();
  });

  it('passes non-.js entrypoints (bin shims) through untouched, even without node', () => {
    expect(hookSpawnCommand('/usr/local/bin/cavemem', null)).toEqual({
      command: '/usr/local/bin/cavemem',
      args: [],
    });
  });

  it('the returned command+args actually execute a .js fixture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cavemem-bridge-'));
    tempDirs.push(dir);
    const fixture = join(dir, 'fixture.js');
    writeFileSync(fixture, 'process.stdout.write("ok")');
    const nodeBin = resolveNodeBinary();
    const cmd = hookSpawnCommand(fixture, nodeBin);
    expect(cmd).not.toBeNull();
    const { command, args } = cmd as { command: string; args: string[] };
    const exit = await new Promise<number | null>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, { stdio: 'ignore' });
      } catch (err) {
        reject(err);
        return;
      }
      child.on('error', reject);
      child.on('close', resolve);
    });
    expect(exit).toBe(0);
  });
});
