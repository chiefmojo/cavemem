import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expand } from '@cavemem/compress';
import { loadSettings, resolveDataDir } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import type { RemoteTarget } from '@cavemem/hooks';
import {
  classifySpawnFailure,
  hookSpawnCommand,
  resolveCavememCli,
  resolveNodeBinary,
} from './opencode-bridge-helpers.js';
import { checkedRemoteTarget } from './util/remote.js';

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
  client: {
    mcp: {
      status: (input: { query: { directory: string } }) => Promise<{
        data?: Record<string, { status?: string }>;
        error?: unknown;
      }>;
    };
  };
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
  close?: () => void;
}

function truncate(value: unknown, max = 2000): string {
  if (value == null) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

// Error name only, never the message: remote-mode exception messages can
// embed the authorization header value (e.g. undici's invalid-header
// TypeError quotes the full `Bearer …` string) or raw settings content
// (JSON.parse failures), and the remote token must never reach the log.
function errorName(err: unknown): string {
  return (err as { name?: string })?.name || 'Error';
}

const LOG_PATH = join(tmpdir(), 'cavemem-bridge-errors.log');
const MCP_STATUS_TIMEOUT_MS = 250;

type McpAvailability = 'connected' | 'unavailable' | 'unknown';

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

export default async function cavememBridge({ client, directory }: PluginInput): Promise<Hooks> {
  const CAVEMEM = resolveCavememCli();

  const NODE_UNAVAILABLE_MSG =
    "Cavemem memory capture is disabled: no usable Node.js runtime was found, so new sessions will not be saved. Install Node.js 20+ and make sure it is on OpenCode's PATH (or rerun `cavemem install --ide opencode`), then restart OpenCode.";
  const CLI_NOT_FOUND_MSG =
    "Cavemem memory capture is disabled: the cavemem CLI could not be found, so new sessions will not be saved. Reinstall with `cavemem install --ide opencode` (or verify cavemem is on OpenCode's PATH), then restart OpenCode.";
  const TOOLS_NOTICE =
    'You have cavemem memory tools (search, timeline, get_observations, list_sessions). Use them when past context would help.';
  const TOOLS_UNAVAILABLE =
    'Cavemem memory tools are unavailable in this OpenCode session because the Cavemem MCP connection is not available.';
  const TOOLS_STATUS_UNKNOWN =
    'Cavemem memory tool availability could not be determined for this OpenCode session.';

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
  // The active user-facing disable message (node missing vs CLI missing), so the
  // system-prompt surfacing and console output agree with the actual cause.
  let disabledMessage: string | null = null;

  function disableCapture(reason: string, userMessage: string): void {
    if (captureDisabled) return;
    captureDisabled = true;
    launchCommand = null;
    disabledMessage = userMessage;
    log(`capture disabled: ${reason}`);
    console.error(`[cavemem] ${userMessage}`);
  }

  function handleSpawnError(hookName: string, err: NodeJS.ErrnoException): void {
    const code = err?.code;
    const msg = err?.message || String(err);
    const kind = classifySpawnFailure(code, usesNodeRuntime);
    if (kind === 'node-unavailable') {
      // The resolved node binary itself is unusable — disable capture loudly.
      disableCapture(`hook ${hookName} node launch failed: ${code} ${msg}`, NODE_UNAVAILABLE_MSG);
    } else if (kind === 'cli-not-found') {
      // A missing CLI on the non-.js path: capture is equally dead, but the
      // remedy is a reinstall, not a Node runtime.
      disableCapture(`hook ${hookName} CLI not found: ${code} ${msg}`, CLI_NOT_FOUND_MSG);
    } else {
      // Transient (EAGAIN/EMFILE) — log and let the next hook retry.
      log(`hook ${hookName} spawn failed: ${code ?? 'ERR'} ${msg}`);
    }
  }

  if (captureDisabled) {
    disabledMessage = NODE_UNAVAILABLE_MSG;
    log('capture disabled at init: no usable Node.js runtime');
    console.error(`[cavemem] ${NODE_UNAVAILABLE_MSG}`);
  }

  // Track which sessions we have already started so we don't duplicate.
  const activeSessions = new Set<string>();
  // Track which sessions already received retrieved context.
  const queriedSessions = new Set<string>();
  // One status request per turn. The next user message starts a new turn and
  // clears this promise; sharing the in-flight promise also deduplicates
  // concurrent system transforms.
  const mcpStatusBySession = new Map<string, Promise<McpAvailability>>();
  // Accumulate assistant message text by message ID.
  const messageTexts = new Map<string, { sessionID: string; text: string }>();
  // Track the latest user message per session so repeated updates for the same
  // prompt do not start extra turns or duplicate MCP status requests.
  const lastUserMessageBySession = new Map<string, string>();

  // Prior-session priming source. Remote mode: prime from the worker via
  // /api/context — the client-local data.db is empty/stale here (WP #222),
  // and opening it would also create a junk empty data.db on remote clients.
  // Local mode: read the local store exactly as before. Both settings load
  // and target resolution are guarded: checkedRemoteTarget throws on an
  // invalid remote.url, and a throw here would take down every bridge hook —
  // including the fire-and-forget writes — so we degrade to no priming at all.
  let store: MemoryStore | undefined;
  let remote: RemoteTarget | undefined;
  try {
    const settings = loadSettings();
    const target = checkedRemoteTarget(settings);
    if (target) {
      remote = target;
    } else {
      const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
      store = new MemoryStore({ dbPath, settings });
    }
  } catch (err) {
    log(`init degraded, priming disabled: ${errorName(err)}`);
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

    try {
      if (remote) {
        // /api/context rejects unscoped reads by design (privacy — a 400 is
        // guaranteed), while the local path treats a falsy directory as "no
        // scoping" and still primes. Skipping beats a doomed round-trip.
        if (!directory) {
          log(`retrieval for ${sessionID}: skipped (no directory to scope by)`);
          return '';
        }
        const u = new URL('/api/context', remote.url);
        u.searchParams.set('cwd', directory);
        u.searchParams.set('exclude', sessionID);
        const res = await fetch(u, {
          headers: { authorization: `Bearer ${remote.token ?? ''}` },
          signal: AbortSignal.timeout(remote.timeoutMs),
        });
        if (!res.ok) {
          // Status is a bare number — safe to log. Never log the exception
          // message or body here: they can embed the authorization value.
          log(`context fetch failed: ${res.status}`);
          return '';
        }
        const body = (await res.json()) as {
          hints?: Array<{ sessionId: string; content: string; compressed: boolean }>;
        };
        const hints = (body.hints ?? [])
          .map((h) => (h.compressed ? expand(h.content) : h.content).trim())
          .filter((t) => t.length > 0);

        log(`retrieval for ${sessionID}: ${hints.length} hints found`);
        if (hints.length === 0) return '';

        const context = `Prior context (internal): ${hints.join(' | ')}`;
        log(`injected ${context.length} chars`);
        return context;
      }

      if (!store) return '';

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
      if (remote) {
        // Remote mode: name only — see errorName() for why the message is
        // unsafe (fetch/header/parse errors can quote the authorization
        // value; timeout failures surface as AbortError/TimeoutError names).
        log(`retrieval error: ${errorName(err)}`);
      } else {
        // Local store errors cannot contain the remote token — keep detail.
        const msg = (err as Error)?.message || String(err);
        log(`retrieval error: ${msg}`);
      }
      return '';
    }
  }

  function cavememToolsAvailability(sessionID: string): Promise<McpAvailability> {
    const cached = mcpStatusBySession.get(sessionID);
    if (cached) return cached;
    const status = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        return await Promise.race([
          Promise.resolve()
            .then(() => client.mcp.status({ query: { directory } }))
            .then((result): McpAvailability => {
              if (result.error) {
                log('MCP status unavailable: SDK error response');
                return 'unknown';
              }
              switch (result.data?.cavemem?.status) {
                case 'connected':
                  return 'connected';
                case undefined:
                case 'failed':
                case 'disabled':
                case 'needs_auth':
                case 'needs_client_registration':
                  return 'unavailable';
                default:
                  log('MCP status unavailable: unrecognized status');
                  return 'unknown';
              }
            })
            .catch((err): McpAvailability => {
              if (!timedOut) log(`MCP status unavailable: ${errorName(err)}`);
              return 'unknown';
            }),
          new Promise<McpAvailability>((resolve) => {
            timeout = setTimeout(() => {
              timedOut = true;
              log('MCP status unavailable: timeout');
              resolve('unknown');
            }, MCP_STATUS_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })();
    mcpStatusBySession.set(sessionID, status);
    return status;
  }

  return {
    close: () => {
      try {
        store?.close();
      } catch {
        // Best-effort: a failed close must never take down the plugin.
      }
      store = undefined;
    },

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
            mcpStatusBySession.delete(sid);
            lastUserMessageBySession.delete(sid);
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
            mcpStatusBySession.delete(session.id);
            lastUserMessageBySession.delete(session.id);
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
              if (lastUserMessageBySession.get(sid) !== mid) {
                mcpStatusBySession.delete(sid);
                lastUserMessageBySession.set(sid, mid);
              }
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
        if (captureDisabled && disabledMessage && !output.system.includes(disabledMessage)) {
          output.system.push(disabledMessage);
        }
        const sid = input?.sessionID;
        if (!sid) return;
        const availability = await cavememToolsAvailability(sid);
        output.system.push(
          availability === 'connected'
            ? TOOLS_NOTICE
            : availability === 'unavailable'
              ? TOOLS_UNAVAILABLE
              : TOOLS_STATUS_UNKNOWN,
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
