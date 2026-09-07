import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookSpawnCommand, resolveNodeBinary } from '../src/opencode-bridge.js';

// Windows: spawn() cannot execute a .js file directly — uv_spawn has no exec
// handler for it and fails with EFTYPE (same failure worker.ts already guards
// against). The bridge must route .js entrypoints through a real node runtime
// — and never through process.execPath when that is the IDE's own binary
// (opencode embeds Bun, so execPath is opencode.exe inside a plugin).
const NOT_NODE = 'C:\\Program Files\\opencode\\opencode.exe';

// PATH-scan fixtures must match the HOST OS, not just the injected platform:
// Windows absolute paths contain drive colons, so a POSIX `:`-delimited PATH
// cannot be simulated on a Windows host (and accessSync(X_OK) there behaves
// like a plain existence check). Using the host's delimiter/name/candidates
// keeps these tests deterministic on any CI OS.
const hostPlatform = process.platform;
const hostNodeName = hostPlatform === 'win32' ? 'node.exe' : 'node';
const hostDelim = hostPlatform === 'win32' ? ';' : ':';

const tempDirs: string[] = [];

function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cavemem-bridge-'));
  tempDirs.push(dir);
  return dir;
}

// Content never matters — these stubs are only stat'd/access'd, never executed.
// chmod 0o755 by default so the POSIX executability check passes on Linux/macOS
// CI (a harmless no-op on Windows). Pass a different mode to simulate a file
// that exists but is not executable.
function writeFakeNode(dir: string, name = 'node', mode: number | null = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const full = join(dir, name);
  writeFileSync(full, 'node stub');
  if (mode !== null) chmodSync(full, mode);
  return full;
}

// The dedicated sidecar the installer writes in both local and remote mode.
function writeBridgeMeta(configDir: string, nodePath: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'cavemem-bridge.json'),
    `${JSON.stringify({ nodeBin: nodePath })}\n`,
  );
}

// The legacy local MCP entry, for installs predating the sidecar.
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
  it('returns execPath when it is a usable node binary, without consulting config or PATH', () => {
    // execPath is now validated like any other candidate, so point it at a real
    // file; the empty env/home prove config and PATH are never consulted.
    const node = writeFakeNode(join(mkTemp(), 'runtime'));
    const result = resolveNodeBinary({
      execPath: node,
      env: {},
      homeDir: mkTemp(),
      platform: 'linux',
    });
    expect(result).toBe(node);
  });

  it('returns null when execPath is the IDE binary, no config exists, and PATH is empty', () => {
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: { PATH: '' },
      homeDir: mkTemp(),
    });
    expect(result).toBeNull();
  });

  it('reads nodeBin from the cavemem-bridge.json sidecar', () => {
    const home = mkTemp();
    const fakeNode = writeFakeNode(join(home, 'runtime'));
    writeBridgeMeta(join(home, '.config', 'opencode'), fakeNode);
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: {},
      homeDir: home,
      platform: 'linux',
    });
    expect(result).toBe(fakeNode);
  });

  it('prefers the sidecar over the legacy mcp.cavemem.command[0] entry', () => {
    const home = mkTemp();
    const sidecarNode = writeFakeNode(join(home, 'runtime'));
    const legacyNode = writeFakeNode(join(home, 'legacy-runtime'));
    const cfgDir = join(home, '.config', 'opencode');
    writeBridgeMeta(cfgDir, sidecarNode);
    writeOpencodeConfig(cfgDir, legacyNode);
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: {},
      homeDir: home,
      platform: 'linux',
    });
    expect(result).toBe(sidecarNode);
  });

  it('falls back to legacy mcp.cavemem.command[0] when only opencode.json exists', () => {
    const home = mkTemp();
    const fakeNode = writeFakeNode(join(home, 'runtime'));
    writeOpencodeConfig(join(home, '.config', 'opencode'), fakeNode);
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: {},
      homeDir: home,
      platform: 'linux',
    });
    expect(result).toBe(fakeNode);
  });

  it('falls through to a PATH scan when the sidecar node path does not exist', () => {
    const home = mkTemp();
    writeBridgeMeta(join(home, '.config', 'opencode'), join(home, 'missing-runtime', 'node'));
    const pathDir = mkTemp();
    const pathNode = writeFakeNode(pathDir, hostNodeName);
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: { PATH: pathDir },
      homeDir: home,
      platform: hostPlatform,
    });
    expect(result).toBe(pathNode);
  });

  it('rejects a bare/relative sidecar nodeBin and falls through to a PATH scan', () => {
    const home = mkTemp();
    writeBridgeMeta(join(home, '.config', 'opencode'), 'node');
    const pathDir = mkTemp();
    const pathNode = writeFakeNode(pathDir, hostNodeName);
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: { PATH: pathDir },
      homeDir: home,
      platform: hostPlatform,
    });
    expect(result).toBe(pathNode);
  });

  // accessSync(X_OK) on Windows behaves like a plain existence check, so a
  // missing execute bit can only be simulated on POSIX hosts.
  const itOnPosix: typeof it = (process.platform === 'win32' ? it.skip : it) as typeof it;

  itOnPosix(
    'rejects a non-executable POSIX node file and falls through to a later valid one',
    () => {
      const earlyDir = mkTemp();
      writeFakeNode(earlyDir, 'node', 0o644); // exists but not executable
      const laterDir = mkTemp();
      const realNode = writeFakeNode(laterDir);
      const result = resolveNodeBinary({
        execPath: NOT_NODE,
        env: { PATH: `${earlyDir}:${laterDir}` },
        homeDir: mkTemp(),
        platform: 'linux',
      });
      expect(result).toBe(realNode);
    },
  );

  it('rejects a directory named node on the PATH and finds a later real binary', () => {
    const earlyDir = mkTemp();
    mkdirSync(join(earlyDir, hostNodeName), { recursive: true });
    const laterDir = mkTemp();
    const realNode = writeFakeNode(laterDir, hostNodeName);
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: { PATH: `${earlyDir}${hostDelim}${laterDir}` },
      homeDir: mkTemp(),
      platform: hostPlatform,
    });
    expect(result).toBe(realNode);
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

  it('on win32 does not let a bare node shim shadow node.exe in a later dir', () => {
    const shimDir = mkTemp();
    writeFakeNode(shimDir, 'node'); // bare shim — not a candidate on win32
    const realDir = mkTemp();
    const nodeExe = writeFakeNode(realDir, 'node.exe');
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: { PATH: `${shimDir};${realDir}` },
      homeDir: mkTemp(),
      platform: 'win32',
    });
    expect(result).toBe(nodeExe);
  });

  it('honors XDG_CONFIG_HOME when reading the bridge sidecar', () => {
    const home = mkTemp();
    // A decoy sidecar at the default location pointing at a missing node: if
    // XDG_CONFIG_HOME were ignored, resolution would fall through to a PATH
    // scan (no PATH injected) and return null instead.
    writeBridgeMeta(join(home, '.config', 'opencode'), join(home, 'missing', 'node'));
    const xdg = mkTemp();
    const fakeNode = writeFakeNode(join(xdg, 'runtime'));
    writeBridgeMeta(join(xdg, 'opencode'), fakeNode);
    const result = resolveNodeBinary({
      execPath: NOT_NODE,
      env: { XDG_CONFIG_HOME: xdg },
      homeDir: home,
      platform: 'linux',
    });
    expect(result).toBe(fakeNode);
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
