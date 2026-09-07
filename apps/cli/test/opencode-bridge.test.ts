import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifySpawnFailure,
  hookSpawnCommand,
  resolveNodeBinary,
} from '../src/opencode-bridge.js';

type SystemTransform = (
  input: { sessionID?: string; model: unknown },
  output: { system: string[] },
) => Promise<void>;

type EventHook = (input: {
  event: { type: string; properties?: Record<string, unknown> };
}) => Promise<void>;

/** Minimal ChildProcess shape the bridge's fire-and-forget runHook touches. */
function fakeChild(): ChildProcess {
  return {
    on: () => {},
    stdin: { on: () => {}, end: () => {} },
    unref: () => {},
  } as unknown as ChildProcess;
}

// Pass-through mock: node built-in ESM namespaces are non-configurable, so
// vi.spyOn(namespace, 'spawn') fails on the raw object. Wrapping the module
// in a factory hands out a vitest proxy namespace whose properties are
// spyable, while every export still delegates to the real implementation.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

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

describe('opencode-bridge prior-context priming', () => {
  let home: string;
  let origHome: string | undefined;
  const closers: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cavemem-bridge-test-'));
    origHome = process.env.CAVEMEM_HOME;
    process.env.CAVEMEM_HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const close of closers.splice(0)) {
      close();
    }
    if (origHome === undefined) delete process.env.CAVEMEM_HOME;
    else process.env.CAVEMEM_HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function loadBridge(
    settings: Record<string, unknown>,
    directory = '/proj',
  ): Promise<{
    'experimental.chat.system.transform': SystemTransform;
    event: EventHook;
    close: () => void;
  }> {
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ embedding: { provider: 'none' }, ...settings }),
    );
    const mod = await import('../src/opencode-bridge.js');
    const hooks = (await mod.default({ $: {} as never, directory })) as {
      'experimental.chat.system.transform': SystemTransform;
      event: EventHook;
      close: () => void;
    };
    closers.push(hooks.close);
    return {
      'experimental.chat.system.transform': hooks['experimental.chat.system.transform'],
      event: hooks.event,
      close: hooks.close,
    };
  }

  async function prime(hooks: { 'experimental.chat.system.transform': SystemTransform }) {
    const output = { system: [] as string[] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses-1', model: {} }, output);
    return output.system;
  }

  it('primes from the worker in remote mode', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            hints: [{ sessionId: 'old-1', content: 'earlier session solved X', compressed: false }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/context');
    expect(url.searchParams.get('cwd')).toBe('/proj');
    expect(url.searchParams.get('exclude')).toBe('ses-1');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(system).toContain('Prior context (internal): earlier session solved X');
  });

  it('expands compressed hints client-side and passes uncompressed hints through verbatim', async () => {
    // 'db'/'cfg' expand to 'database'/'configuration' — a discriminating
    // fixture: the compressed hint must come back expanded, the control
    // hint (compressed: false) must keep the abbreviations byte-for-byte.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            hints: [
              { sessionId: 'old-1', content: 'fixed the db cfg', compressed: true },
              { sessionId: 'old-2', content: 'db cfg note kept as stored', compressed: false },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    expect(system).toContain(
      'Prior context (internal): fixed the database configuration | db cfg note kept as stored',
    );
  });

  it('fail-open: remote 500 yields no priming and no throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
  });

  it('never logs the remote token when fetch throws an invalid-header error', async () => {
    const logPath = join(tmpdir(), 'cavemem-bridge-errors.log');
    let logBefore = '';
    try {
      logBefore = readFileSync(logPath, 'utf8');
    } catch {
      // No log file yet.
    }
    // undici's header validation throws a TypeError whose message quotes the
    // full authorization value — if that message reaches the bridge log, the
    // token is disclosed.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(`Headers.append: "Bearer tok" is an invalid header value.`);
      }),
    );

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
    const appended = readFileSync(logPath, 'utf8').slice(logBefore.length);
    // Fixed error category only — never the exception message.
    expect(appended).toContain('retrieval error: TypeError');
    expect(appended).not.toContain('tok');
  });

  it('degrades to no priming on invalid remote.url without throwing at init', async () => {
    // canonicalRemoteUrl rejects URLs with a path/query/fragment;
    // checkedRemoteTarget rethrows — init must catch it, not crash the plugin.
    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777/has/path', token: 'tok' } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
  });

  it('fail-open: fetch timeout aborts the wait and yields no priming', async () => {
    // Never resolves on its own — only the bridge's AbortSignal.timeout can
    // settle it. If the bridge ignored the abort (or hung), this test times
    // out; if it threw, prime() rejects.
    const fetchMock = vi.fn((_url: URL | string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 20 } }),
    );

    expect(system.join('\n')).not.toContain('Prior context');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('suppresses repeat context fetches for the same sessionID', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ hints: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Same plugin instance, same sessionID twice: the queriedSessions guard
    // must dedupe (the session.idle reset is deliberately not exercised here).
    const hooks = await loadBridge({
      remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 },
    });
    await prime(hooks);
    await prime(hooks);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('remote mode never creates the client-local data.db', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            hints: [{ sessionId: 'old-1', content: 'remote hint', compressed: false }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge({ remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } }),
    );

    // Priming came from the worker, not a store opened on the temp home —
    // opening it would create a junk empty data.db on remote clients.
    expect(system).toContain('Prior context (internal): remote hint');
    expect(existsSync(join(home, 'data.db'))).toBe(false);
  });

  it('degraded init keeps the write dispatch alive', async () => {
    // Spy BEFORE importing the bridge: after vi.resetModules() the bridge's
    // own 'node:child_process' import resolves to the same proxied namespace.
    const childProcess = await import('node:child_process');
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(fakeChild);

    const hooks = await loadBridge({
      remote: { url: 'http://worker:37777/has/path', token: 'tok' },
    });
    await expect(
      hooks.event({
        event: {
          type: 'session.created',
          properties: { info: { id: 'ses-9', directory: '/proj' } },
        },
      }),
    ).resolves.toBeUndefined();

    // .js CLIs route through the resolved node runtime (args gain a leading
    // entrypoint element); bin shims do not. The hook dispatch tail is
    // invariant across both launch modes.
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const args = spawnSpy.mock.calls[0]?.[1] as string[];
    expect(args.slice(-5)).toEqual(['hook', 'run', 'session-start', '--ide', 'opencode']);
  });

  it('remote mode skips the fetch when the plugin directory is empty', async () => {
    // /api/context rejects unscoped reads by design (400), while the local
    // path treats a falsy directory as "no scoping" and still primes — so an
    // empty directory must skip priming instead of round-tripping a
    // guaranteed 400.
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ hints: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const system = await prime(
      await loadBridge(
        { remote: { url: 'http://worker:37777', token: 'tok', timeoutMs: 200 } },
        '',
      ),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(system.join('\n')).not.toContain('Prior context');
  });

  it('local mode reads the client-local store exactly as before', async () => {
    const dbPath = join(home, 'data.db');
    const seed = new MemoryStore({ dbPath, settings: defaultSettings });
    seed.startSession({ id: 'local-1', ide: 'opencode', cwd: '/proj', metadata: null });
    seed.endSession('local-1');
    seed.storage.insertSummary({
      session_id: 'local-1',
      scope: 'session',
      content: 'local summary text',
      compressed: false,
      intensity: null,
    });
    seed.close();

    const system = await prime(await loadBridge({ dataDir: home }));

    expect(system).toContain('Prior context (internal): local summary text');
  });
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

describe('classifySpawnFailure', () => {
  it('treats a fatal errno on the node-runtime path as node-unavailable', () => {
    for (const code of ['ENOENT', 'ENOEXEC', 'EFTYPE']) {
      expect(classifySpawnFailure(code, true)).toBe('node-unavailable');
    }
  });

  it('treats ENOENT on the non-.js (bin-shim) path as cli-not-found', () => {
    expect(classifySpawnFailure('ENOENT', false)).toBe('cli-not-found');
  });

  it('treats transient errnos as non-fatal (log only)', () => {
    expect(classifySpawnFailure('EAGAIN', true)).toBe('transient');
    expect(classifySpawnFailure('EMFILE', true)).toBe('transient');
    expect(classifySpawnFailure('EAGAIN', false)).toBe('transient');
  });

  it('treats a non-ENOENT errno on the bin-shim path as transient', () => {
    expect(classifySpawnFailure('EACCES', false)).toBe('transient');
    expect(classifySpawnFailure(undefined, false)).toBe('transient');
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
