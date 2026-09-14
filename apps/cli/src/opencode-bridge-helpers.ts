import { execFileSync } from 'node:child_process';
import { constants, accessSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
// Cavemem binary discovery
/* ------------------------------------------------------------------ */

export function resolveCavememCli(): string {
  // Strategy 1: we're bundled alongside the CLI entrypoint (same dist/ dir).
  const bridgePath = fileURLToPath(import.meta.url);
  const bridgeDir = dirname(bridgePath);
  const sibling = join(bridgeDir, 'index.js');
  if (existsSync(sibling)) return sibling;

  // Strategy 2: global npm binary.
  try {
    const result = execFileSync('which', ['cavemem'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (result) return result;
  } catch {}

  // Strategy 3: derive from npm global root.
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const fromNpm = join(globalRoot, 'cavemem', 'dist', 'index.js');
    if (existsSync(fromNpm)) return fromNpm;
  } catch {}

  return 'cavemem';
}

/* ------------------------------------------------------------------ */
// Node runtime resolution
/* ------------------------------------------------------------------ */

// spawn() cannot execute a .js file directly on win32 — uv_spawn has no exec
// handler for it and fails with EFTYPE (same reason commands/worker.ts spawns
// `node <cli>`). Route .js entrypoints through a real node runtime. Beware
// process.execPath: inside an IDE-embedded runtime (e.g. opencode's compiled
// Bun binary) it is the IDE executable, not node — spawning it would launch
// the IDE recursively. Use it only when it is node.
interface ResolveNodeBinaryOptions {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export function isNodeExec(p: string): boolean {
  return /(^|[/\\])node(\.exe)?$/i.test(p);
}

// A candidate node binary is usable only if it is an absolute path whose
// basename is node/node.exe, is a regular file, and (on POSIX) is executable.
// Rejects bare `node`, relative paths, directories, and non-exec files so a
// bogus candidate falls through to the next source instead of being spawned.
function isUsableNode(p: string, platform: NodeJS.Platform): boolean {
  if (!isNodeExec(p) || !isAbsolute(p)) return false;
  try {
    if (platform === 'win32') return statSync(p).isFile();
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function opencodeConfigDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'opencode') : join(homeDir, '.config', 'opencode');
}

// Absolute node recorded at install time. Prefer the dedicated sidecar the
// installer writes in BOTH local and remote mode; fall back to the legacy
// local MCP entry (`mcp.cavemem.command[0]`) for installs predating it.
function nodeFromOpencodeConfig(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  const dir = opencodeConfigDir(env, homeDir);
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'cavemem-bridge.json'), 'utf8')) as {
      nodeBin?: unknown;
    };
    if (typeof meta.nodeBin === 'string') return meta.nodeBin;
  } catch {
    /* fall through to legacy */
  }
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8')) as {
      mcp?: { cavemem?: { type?: string; command?: unknown } };
    };
    const entry = parsed.mcp?.cavemem;
    if (entry && entry.type === 'local' && Array.isArray(entry.command)) {
      const cmd = entry.command[0];
      if (typeof cmd === 'string') return cmd;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// win32: only `node.exe` (a bare `node` on Windows PATH is typically a shim
// that would shadow the real binary). POSIX: `node`, required to be executable.
// Skips empty and relative PATH entries (never search the project directory).
function findNodeOnPath(envPath: string | undefined, platform: NodeJS.Platform): string | null {
  if (!envPath) return null;
  const delim = platform === 'win32' ? ';' : ':';
  const name = platform === 'win32' ? 'node.exe' : 'node';
  for (const rawDir of envPath.split(delim)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !isAbsolute(dir)) continue;
    if (isUsableNode(join(dir, name), platform)) return join(dir, name);
  }
  return null;
}

// Resolution chain: (1) process.execPath if it is node; (2) the absolute node
// binary the installer recorded; (3) a PATH scan; (4) null. No Node runtime is
// bundled inside OpenCode, and the absolute path recorded by `cavemem install`
// is more reliable than a PATH scan for desktop-launched OpenCode (whose PATH
// may not include node). When nothing resolves, hookSpawnCommand returns null
// so the bridge can disable capture with a visible warning instead of silently
// dropping every hook.
export function resolveNodeBinary(options: ResolveNodeBinaryOptions = {}): string | null {
  const execPath = options.execPath ?? process.execPath ?? '';
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;

  if (isUsableNode(execPath, platform)) return execPath;

  const fromConfig = nodeFromOpencodeConfig(env, homeDir);
  if (fromConfig && isUsableNode(fromConfig, platform)) return fromConfig;

  return findNodeOnPath(env.PATH ?? env.Path, platform);
}

// Routes .js entrypoints through the resolved node runtime; returns null when a
// runtime is required but absent (the bridge then disables capture with a
// visible warning rather than silently dropping hooks). Non-.js bin shims pass
// through untouched.
export function hookSpawnCommand(
  cliPath: string,
  nodeBin: string | null,
): { command: string; args: string[] } | null {
  if (cliPath.endsWith('.js')) {
    return nodeBin ? { command: nodeBin, args: [cliPath] } : null;
  }
  return { command: cliPath, args: [] };
}

const NODE_FATAL_CODES = new Set(['ENOENT', 'ENOEXEC', 'EFTYPE']);

export type SpawnFailure = 'node-unavailable' | 'cli-not-found' | 'transient';

// Maps a spawn errno to the action the bridge should take. `usesNodeRuntime`
// is true only when a `.js` CLI is routed through the resolved node binary; the
// bin-shim / bare-`cavemem` path never uses node, so ENOENT there means the CLI
// itself is missing — a different failure with a different remedy.
export function classifySpawnFailure(
  code: string | undefined,
  usesNodeRuntime: boolean,
): SpawnFailure {
  if (usesNodeRuntime && code && NODE_FATAL_CODES.has(code)) return 'node-unavailable';
  if (!usesNodeRuntime && code === 'ENOENT') return 'cli-not-found';
  return 'transient';
}
