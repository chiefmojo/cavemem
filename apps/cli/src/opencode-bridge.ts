import { execFileSync, spawn } from 'node:child_process';
import { constants, accessSync, appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expand } from '@cavemem/compress';
import { loadSettings, resolveDataDir } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';

/* ------------------------------------------------------------------ */
// Minimal local types for the OpenCode plugin API (no runtime dependency
// on @opencode-ai/plugin — the bridge is loaded dynamically by OpenCode).
/* ------------------------------------------------------------------ */

type BunShell = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown> & { text(): Promise<string> };

interface PluginInput {
  $: BunShell;
  directory: string;
}

interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface Hooks {
  event?: (input: { event: OpenCodeEvent }) => Promise<void>;
  'tool.execute.after'?: (
    input: { sessionID: string; tool: string; args: unknown },
    output: { output: unknown },
  ) => Promise<void>;
  'experimental.chat.system.transform'?: (
    input: { sessionID?: string; model: unknown },
    output: { system: string[] },
  ) => Promise<void>;
}

/* ------------------------------------------------------------------ */
// Cavemem binary discovery
/* ------------------------------------------------------------------ */

function resolveCavememCli(): string {
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
// Helpers
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

function truncate(value: unknown, max = 2000): string {
  if (value == null) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

const LOG_PATH = join(tmpdir(), 'cavemem-bridge-errors.log');

function log(msg: string): void {
  try {
    // Plain fs append — no subprocess, so this can never itself block the
    // IDE waiting on a shell round-trip.
    appendFileSync(LOG_PATH, `[cavemem-bridge] ${msg}\n`);
  } catch {
    // Silent — logging must never break the main flow.
  }
}

/* ------------------------------------------------------------------ */
// Plugin
/* ------------------------------------------------------------------ */

export default async function cavememBridge({ directory }: PluginInput): Promise<Hooks> {
  const CAVEMEM = resolveCavememCli();

  const NODE_UNAVAILABLE_MSG =
    "Cavemem memory capture is disabled: no usable Node.js runtime was found, so new sessions will not be saved. Install Node.js 20+ and make sure it is on OpenCode's PATH (or rerun `cavemem install --ide opencode`), then restart OpenCode.";

  // Resolve node on every platform: a `.js` CLI needs a runtime everywhere, and
  // on POSIX the `#!/usr/bin/env node` shebang searches the same inherited PATH
  // this scan does — so an absolute resolved node is strictly more reliable.
  const nodeBin = resolveNodeBinary();
  // True only when we are routing a `.js` CLI through the resolved node binary
  // (the bin-shim / bare-`cavemem` path never uses node).
  const usesNodeRuntime = CAVEMEM.endsWith('.js') && nodeBin !== null;

  let launchCommand: { command: string; args: string[] } | null = hookSpawnCommand(
    CAVEMEM,
    nodeBin,
  );
  let captureDisabled = launchCommand === null;

  // Errnos that prove the resolved node binary itself cannot run (vs transient
  // resource failures, or a missing CLI on the non-.js path).
  const NODE_FATAL_CODES = new Set(['ENOENT', 'ENOEXEC', 'EFTYPE']);

  function disableCapture(reason: string): void {
    if (captureDisabled) return;
    captureDisabled = true;
    launchCommand = null;
    log(`capture disabled: ${reason}`);
    console.error(`[cavemem] ${NODE_UNAVAILABLE_MSG}`);
  }

  function handleSpawnError(hookName: string, err: NodeJS.ErrnoException): void {
    const code = err?.code;
    const msg = err?.message || String(err);
    if (usesNodeRuntime && code && NODE_FATAL_CODES.has(code)) {
      // The resolved node binary itself is unusable — disable capture loudly.
      disableCapture(`hook ${hookName} node launch failed: ${code} ${msg}`);
    } else {
      // Transient (EAGAIN/EMFILE) or a non-runtime problem (e.g. missing CLI on
      // the bin-shim path) — log and let the next hook retry.
      log(`hook ${hookName} spawn failed: ${code ?? 'ERR'} ${msg}`);
    }
  }

  if (captureDisabled) {
    log('capture disabled at init: no usable Node.js runtime');
    console.error(`[cavemem] ${NODE_UNAVAILABLE_MSG}`);
  }

  // Track which sessions we have already started so we don't duplicate.
  const activeSessions = new Set<string>();
  // Track which sessions already received retrieved context.
  const queriedSessions = new Set<string>();
  // Accumulate assistant message text by message ID.
  const messageTexts = new Map<string, { sessionID: string; text: string }>();
  // Track which message IDs are user messages (for prompt capture).
  const userMessageIds = new Set<string>();

  // Load settings and open the store once for read-only context retrieval.
  // The store is used only for prior-session priming; all writes go through
  // the cavemem CLI hook commands so they follow the compression + redaction
  // pipeline enforced by MemoryStore.
  let store: MemoryStore | undefined;
  try {
    const settings = loadSettings();
    const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
    store = new MemoryStore({ dbPath, settings });
  } catch {
    // If settings or DB are missing, prior-session context is simply skipped.
  }

  async function runHook(name: string, data: Record<string, unknown>): Promise<void> {
    // Fire-and-forget: detached + unref so the IDE never waits on the CLI
    // subprocess (compression, SQLite insert, worker auto-spawn probe). Never
    // await the child's exit here — that would block every hook-triggering
    // event on a full `cavemem hook run` round-trip.
    if (captureDisabled || !launchCommand) return;
    const { command, args } = launchCommand;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args, 'hook', 'run', name, '--ide', 'opencode'], {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
      });
    } catch (err) {
      handleSpawnError(name, err as NodeJS.ErrnoException);
      return;
    }
    child.on('error', (err) => handleSpawnError(name, err as NodeJS.ErrnoException));
    child.on('close', (exitCode, signal) => {
      if (exitCode !== 0 && exitCode !== null) {
        log(`hook ${name} exited ${exitCode}${signal ? ` (${signal})` : ''}`);
      }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(data));
    child.unref();
  }

  async function flushTurn(sessionID: string, messageID: string): Promise<void> {
    const entry = messageTexts.get(messageID);
    if (!entry) return;
    const text = entry.text.trim();
    messageTexts.delete(messageID);
    if (!text) return;
    await runHook('stop', {
      session_id: sessionID,
      turn_summary: text,
    });
  }

  async function getRecentContext(sessionID: string): Promise<string> {
    if (!sessionID) return '';
    if (queriedSessions.has(sessionID)) return '';
    queriedSessions.add(sessionID);

    if (!store) return '';

    try {
      const sessions = store.storage.listSessions(50);
      // Scope to the current project directory — otherwise opening OpenCode
      // in project A can inject summaries from an unrelated project B
      // session (privacy + relevance bug; see the same fix applied to the
      // Claude Code session-start handler in #39). Falls back to unscoped
      // behaviour only if we somehow have no directory to compare against.
      const ended = sessions
        .filter(
          (s) => s.id !== sessionID && s.ended_at !== null && (!directory || s.cwd === directory),
        )
        .sort((a, b) => b.started_at - a.started_at)
        .slice(0, 3);

      const hints: string[] = [];
      for (const session of ended) {
        const summaries = store.storage.listSummaries(session.id);
        const sessionSummary = summaries.find((s) => s.scope === 'session');
        if (!sessionSummary) continue;

        const raw = sessionSummary.content;
        const text = sessionSummary.compressed === 1 ? expand(raw) : raw;
        if (text.trim()) hints.push(text.trim());
      }

      log(`retrieval for ${sessionID}: ${hints.length} summaries found`);
      if (hints.length === 0) return '';

      const context = `Prior context (internal): ${hints.join(' | ')}`;
      log(`injected ${context.length} chars`);
      return context;
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      log(`retrieval error: ${msg}`);
      return '';
    }
  }

  return {
    event: async ({ event }) => {
      try {
        if (!event) return;

        switch (event.type) {
          case 'session.created': {
            const session = event.properties?.info as
              | { id: string; directory?: string }
              | undefined;
            if (!session) return;
            if (activeSessions.has(session.id)) return;
            activeSessions.add(session.id);
            await runHook('session-start', {
              session_id: session.id,
              ide: 'opencode',
              cwd: session.directory || directory,
            });
            break;
          }

          case 'session.idle': {
            const sid = event.properties?.sessionID as string | undefined;
            if (!sid) return;
            for (const [mid, entry] of messageTexts) {
              if (entry.sessionID === sid) await flushTurn(sid, mid);
            }
            activeSessions.delete(sid);
            queriedSessions.delete(sid);
            await runHook('session-end', { session_id: sid });
            break;
          }

          case 'session.deleted': {
            const session = event.properties?.info as { id: string } | undefined;
            if (!session) return;
            for (const [mid, entry] of messageTexts) {
              if (entry.sessionID === session.id) await flushTurn(session.id, mid);
            }
            activeSessions.delete(session.id);
            queriedSessions.delete(session.id);
            await runHook('session-end', {
              session_id: session.id,
            });
            break;
          }

          case 'command.executed': {
            const props = event.properties as
              | { sessionID?: string; name?: string; arguments?: unknown }
              | undefined;
            if (!props) return;
            await runHook('post-tool-use', {
              session_id: props.sessionID,
              tool_name: `cmd:${props.name}`,
              tool_input: truncate(props.arguments, 500),
              tool_response: '',
            });
            break;
          }

          case 'message.part.updated': {
            const props = event.properties as
              | {
                  part?: {
                    type: string;
                    sessionID?: string;
                    messageID?: string;
                    text?: string;
                  };
                  delta?: string;
                }
              | undefined;
            if (!props) return;
            const part = props.part;
            if (!part || part.type !== 'text') return;
            const sid = part.sessionID;
            const mid = part.messageID;
            if (!sid || !mid) return;
            const delta = props.delta;
            const text = part.text || '';
            const entry = messageTexts.get(mid);
            if (entry) {
              entry.text += delta || text;
            } else {
              messageTexts.set(mid, {
                sessionID: sid,
                text: delta || text,
              });
            }
            break;
          }

          case 'message.updated': {
            const info = event.properties?.info as
              | {
                  id?: string;
                  sessionID?: string;
                  role?: string;
                  summary?: { body?: string };
                  time?: { completed?: boolean };
                }
              | undefined;
            if (!info) return;
            const sid = info.sessionID;
            const mid = info.id;
            if (!sid || !mid) return;

            if (info.role === 'user') {
              userMessageIds.add(mid);
              const buffered = messageTexts.get(mid);
              const text = info.summary?.body || buffered?.text || '';
              messageTexts.delete(mid);
              if (text.trim()) {
                await runHook('user-prompt-submit', {
                  session_id: sid,
                  prompt: text.trim(),
                });
              }
            } else if (info.role === 'assistant' && info.time?.completed) {
              await flushTurn(sid, mid);
            }
            break;
          }
        }
      } catch (err) {
        const msg = (err as Error)?.message || String(err);
        log(`event handler crash: ${msg.slice(0, 500)}`);
      }
    },

    'tool.execute.after': async (input, output) => {
      try {
        if (!input?.sessionID) return;
        await runHook('post-tool-use', {
          session_id: input.sessionID,
          tool_name: input.tool,
          tool_input: truncate(input.args, 500),
          tool_response: truncate(output?.output, 2000),
        });
      } catch (err) {
        const msg = (err as Error)?.message || String(err);
        log(`tool.execute.after crash: ${msg.slice(0, 500)}`);
      }
    },

    'experimental.chat.system.transform': async (input, output) => {
      try {
        if (captureDisabled && !output.system.includes(NODE_UNAVAILABLE_MSG)) {
          output.system.push(NODE_UNAVAILABLE_MSG);
        }
        const sid = input?.sessionID;
        if (!sid) return;
        output.system.push(
          'You have cavemem memory tools (search, timeline, get_observations, list_sessions). Use them when past context would help.',
        );
        const context = await getRecentContext(sid);
        if (context) {
          output.system.push(context);
        }
      } catch (err) {
        const msg = (err as Error)?.message || String(err);
        log(`system.transform crash: ${msg.slice(0, 500)}`);
      }
    },
  };
}
