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

// Host-neutral bridge state shared by the OpenCode V1 and V2 adapters. The
// adapters translate host events into these calls; the `cavemem hook run`
// payloads are identical for both hosts.

export function truncate(value: unknown, max = 2000): string {
  if (value == null) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

// Error name only, never the message: remote-mode exception messages can
// embed the authorization header value (e.g. undici's invalid-header
// TypeError quotes the full `Bearer …` string) or raw settings content
// (JSON.parse failures), and the remote token must never reach the log.
export function errorName(err: unknown): string {
  return (err as { name?: string })?.name || 'Error';
}

const LOG_PATH = join(tmpdir(), 'cavemem-bridge-errors.log');
const MCP_STATUS_TIMEOUT_MS = 250;

export function log(msg: string): void {
  try {
    // Plain fs append — no subprocess, so this can never itself block the
    // IDE waiting on a shell round-trip.
    appendFileSync(LOG_PATH, `[cavemem-bridge] ${msg}\n`);
  } catch {
    // Silent — logging must never break the main flow.
  }
}

export function errorMessage(err: unknown): string {
  return ((err as Error)?.message || String(err)).slice(0, 500);
}

type McpAvailability = 'connected' | 'unavailable' | 'unknown';

/**
 * Host-specific lookup of the `cavemem` MCP server status. `status` is the
 * host's raw status string, or undefined when the server is not registered.
 */
export type McpStatusReader = () => Promise<{ error?: unknown; status?: string | undefined }>;

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

export interface BridgeCore {
  startSession(sessionID: string, cwd: string | undefined): Promise<void>;
  /** Records a user prompt once per message and starts a new MCP-status turn. */
  userPrompt(sessionID: string, messageID: string, text: string): Promise<void>;
  /** A new user message started a turn without (yet) carrying prompt text. */
  beginTurn(sessionID: string, messageID: string): void;
  /** Buffers assistant text. `append` adds a streamed delta; `replace` sets the full text. */
  bufferText(sessionID: string, messageID: string, text: string, mode: 'append' | 'replace'): void;
  takeBufferedText(messageID: string): string | undefined;
  flushMessage(sessionID: string, messageID: string): Promise<void>;
  /** Flushes buffered turns, forgets per-session state, and records session-end. */
  endSession(sessionID: string): Promise<void>;
  toolUsed(
    sessionID: string | undefined,
    tool: string,
    input: unknown,
    response: unknown,
  ): Promise<void>;
  /** System-prompt additions for this request, in insertion order. */
  systemAdditions(sessionID: string | undefined): Promise<string[]>;
  close(): void;
}

export function createBridgeCore(directory: string, readMcpStatus: McpStatusReader): BridgeCore {
  const CAVEMEM = resolveCavememCli();

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

  async function flushMessage(sessionID: string, messageID: string): Promise<void> {
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

  function beginTurn(sessionID: string, messageID: string): void {
    if (lastUserMessageBySession.get(sessionID) !== messageID) {
      mcpStatusBySession.delete(sessionID);
      lastUserMessageBySession.set(sessionID, messageID);
    }
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
            .then(() => readMcpStatus())
            .then((result): McpAvailability => {
              if (result.error) {
                log('MCP status unavailable: SDK error response');
                return 'unknown';
              }
              switch (result.status) {
                case 'connected':
                  return 'connected';
                case undefined:
                case 'failed':
                case 'disabled':
                case 'needs_auth':
                case 'needs_client_registration':
                  return 'unavailable';
                // V2 reports a server that is still connecting as pending;
                // it may come up within this turn, so stay neutral.
                case 'pending':
                  return 'unknown';
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
    async startSession(sessionID, cwd) {
      if (activeSessions.has(sessionID)) return;
      activeSessions.add(sessionID);
      await runHook('session-start', {
        session_id: sessionID,
        ide: 'opencode',
        cwd: cwd || directory,
      });
    },

    async userPrompt(sessionID, messageID, text) {
      beginTurn(sessionID, messageID);
      if (text.trim()) {
        await runHook('user-prompt-submit', {
          session_id: sessionID,
          prompt: text.trim(),
        });
      }
    },

    beginTurn,

    bufferText(sessionID, messageID, text, mode) {
      const entry = messageTexts.get(messageID);
      if (entry && mode === 'append') {
        entry.text += text;
      } else {
        messageTexts.set(messageID, { sessionID, text });
      }
    },

    takeBufferedText(messageID) {
      const entry = messageTexts.get(messageID);
      messageTexts.delete(messageID);
      return entry?.text;
    },

    flushMessage,

    async endSession(sessionID) {
      for (const [mid, entry] of messageTexts) {
        if (entry.sessionID === sessionID) await flushMessage(sessionID, mid);
      }
      activeSessions.delete(sessionID);
      queriedSessions.delete(sessionID);
      mcpStatusBySession.delete(sessionID);
      lastUserMessageBySession.delete(sessionID);
      await runHook('session-end', { session_id: sessionID });
    },

    async toolUsed(sessionID, tool, input, response) {
      await runHook('post-tool-use', {
        session_id: sessionID,
        tool_name: tool,
        tool_input: truncate(input, 500),
        tool_response: truncate(response, 2000),
      });
    },

    async systemAdditions(sessionID) {
      const additions: string[] = [];
      if (captureDisabled && disabledMessage) additions.push(disabledMessage);
      if (!sessionID) return additions;
      const availability = await cavememToolsAvailability(sessionID);
      additions.push(
        availability === 'connected'
          ? TOOLS_NOTICE
          : availability === 'unavailable'
            ? TOOLS_UNAVAILABLE
            : TOOLS_STATUS_UNKNOWN,
      );
      const context = await getRecentContext(sessionID);
      if (context) additions.push(context);
      return additions;
    },

    close() {
      try {
        store?.close();
      } catch {
        // Best-effort: a failed close must never take down the plugin.
      }
      store = undefined;
    },
  };
}
