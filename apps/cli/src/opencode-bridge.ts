import { createBridgeCore, errorMessage, log } from './opencode-bridge-core.js';

/* ------------------------------------------------------------------ */
// Minimal local types for the OpenCode plugin APIs (no runtime dependency
// on @opencode-ai/plugin or @opencode/plugin — the bridge is loaded
// dynamically by OpenCode from a symlink and cannot resolve them).
/* ------------------------------------------------------------------ */

type BunShell = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown> & { text(): Promise<string> };

interface V1PluginInput {
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

interface V1Event {
  type: string;
  properties?: Record<string, unknown>;
}

interface V1Hooks {
  event?: (input: { event: V1Event }) => Promise<void>;
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

interface V2Registration {
  dispose: () => Promise<void>;
}

interface V2Event {
  type: string;
  location?: { directory?: string };
  data?: Record<string, unknown>;
}

interface V2PromptEvent {
  sessionID: string;
  messageID: string;
  prompt?: { text?: string };
}

interface V2ContextEvent {
  sessionID: string;
  system: Array<{ type: 'text'; text: string }>;
}

type V2ToolAfterEvent = {
  tool: string;
  sessionID: string;
  input: unknown;
} & (
  | {
      status: 'completed';
      result?: { content?: Array<{ type: string; text?: string }>; output?: unknown };
    }
  | { status: 'error'; error?: unknown }
);

interface V2PluginContext {
  location: { directory: string };
  event: { subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<V2Event> };
  session: {
    hook(name: 'prompt', cb: (event: V2PromptEvent) => Promise<void>): Promise<V2Registration>;
    hook(name: 'context', cb: (event: V2ContextEvent) => Promise<void>): Promise<V2Registration>;
  };
  tool: {
    hook(
      name: 'execute.after',
      cb: (event: V2ToolAfterEvent) => Promise<void>,
    ): Promise<V2Registration>;
  };
  mcp: {
    list: (input?: { location?: { directory?: string } }) => Promise<{
      data?: ReadonlyArray<{ name: string; status?: { status?: string } }>;
    }>;
  };
}

/* ------------------------------------------------------------------ */
// OpenCode V1 (>= 1.18.29 for the object entrypoint): `server()` returns a
// flat hook map.
/* ------------------------------------------------------------------ */

async function server({ client, directory }: V1PluginInput): Promise<V1Hooks> {
  const core = createBridgeCore(directory, async () => {
    const result = await client.mcp.status({ query: { directory } });
    return { error: result.error, status: result.data?.cavemem?.status };
  });

  return {
    close: () => core.close(),

    event: async ({ event }) => {
      try {
        if (!event) return;

        switch (event.type) {
          case 'session.created': {
            const session = event.properties?.info as
              | { id: string; directory?: string }
              | undefined;
            if (!session) return;
            await core.startSession(session.id, session.directory);
            break;
          }

          case 'session.idle': {
            const sid = event.properties?.sessionID as string | undefined;
            if (!sid) return;
            await core.endSession(sid);
            break;
          }

          case 'session.deleted': {
            const session = event.properties?.info as { id: string } | undefined;
            if (!session) return;
            await core.endSession(session.id);
            break;
          }

          case 'command.executed': {
            const props = event.properties as
              | { sessionID?: string; name?: string; arguments?: unknown }
              | undefined;
            if (!props) return;
            await core.toolUsed(props.sessionID, `cmd:${props.name}`, props.arguments, '');
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
            core.bufferText(sid, mid, props.delta || part.text || '', 'append');
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
              const buffered = core.takeBufferedText(mid);
              await core.userPrompt(sid, mid, info.summary?.body || buffered || '');
            } else if (info.role === 'assistant' && info.time?.completed) {
              await core.flushMessage(sid, mid);
            }
            break;
          }
        }
      } catch (err) {
        log(`event handler crash: ${errorMessage(err)}`);
      }
    },

    'tool.execute.after': async (input, output) => {
      try {
        if (!input?.sessionID) return;
        await core.toolUsed(input.sessionID, input.tool, input.args, output?.output);
      } catch (err) {
        log(`tool.execute.after crash: ${errorMessage(err)}`);
      }
    },

    'experimental.chat.system.transform': async (input, output) => {
      try {
        for (const text of await core.systemAdditions(input?.sessionID)) {
          if (!output.system.includes(text)) output.system.push(text);
        }
      } catch (err) {
        log(`system.transform crash: ${errorMessage(err)}`);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
// OpenCode V2: `setup(ctx)` registers hooks per domain and returns cleanup.
// One background service runs a setup per location (directory) and
// broadcasts events for every location, so events are scoped here.
/* ------------------------------------------------------------------ */

function sameDirectory(a: string | undefined, b: string): boolean {
  if (!a || !b) return false;
  const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
  return trim(a) === trim(b);
}

function toolResponse(event: V2ToolAfterEvent): unknown {
  if (event.status === 'error') return event.error;
  const text = (event.result?.content ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  return text || event.result?.output;
}

async function setup(ctx: V2PluginContext): Promise<() => Promise<void>> {
  const directory = ctx.location.directory;
  const core = createBridgeCore(directory, async () => {
    const result = await ctx.mcp.list({ location: { directory } });
    const cavemem = result.data?.find((s) => s.name === 'cavemem');
    return { status: cavemem?.status?.status };
  });

  // Turn-lifecycle events (`session.execution.*`) carry no location, so an
  // event without one is ours only for a session this instance has already
  // seen in its own location or through its own hooks.
  const ownSessions = new Set<string>();
  const owns = (event: V2Event, sessionID: string): boolean => {
    const eventDir = event.location?.directory;
    if (eventDir !== undefined) {
      if (!sameDirectory(eventDir, directory)) return false;
      ownSessions.add(sessionID);
      return true;
    }
    return ownSessions.has(sessionID);
  };

  const registrations: V2Registration[] = [];
  const controller = new AbortController();

  try {
    registrations.push(
      await ctx.session.hook('prompt', async (event) => {
        try {
          if (!event?.sessionID || !event.messageID) return;
          ownSessions.add(event.sessionID);
          await core.userPrompt(event.sessionID, event.messageID, event.prompt?.text ?? '');
        } catch (err) {
          log(`prompt hook crash: ${errorMessage(err)}`);
        }
      }),
    );

    registrations.push(
      await ctx.session.hook('context', async (event) => {
        try {
          if (event?.sessionID) ownSessions.add(event.sessionID);
          for (const text of await core.systemAdditions(event?.sessionID)) {
            if (!event.system.some((part) => part.text === text)) {
              event.system.push({ type: 'text', text });
            }
          }
        } catch (err) {
          log(`context hook crash: ${errorMessage(err)}`);
        }
      }),
    );

    registrations.push(
      await ctx.tool.hook('execute.after', async (event) => {
        try {
          if (!event?.sessionID) return;
          ownSessions.add(event.sessionID);
          await core.toolUsed(event.sessionID, event.tool, event.input, toolResponse(event));
        } catch (err) {
          log(`tool execute.after crash: ${errorMessage(err)}`);
        }
      }),
    );
  } catch (err) {
    await Promise.allSettled(registrations.map((r) => r.dispose()));
    core.close();
    throw err;
  }

  const handleEvent = async (event: V2Event): Promise<void> => {
    const data = event.data ?? {};
    const sessionID = typeof data.sessionID === 'string' ? data.sessionID : undefined;
    if (!sessionID || !owns(event, sessionID)) return;

    switch (event.type) {
      case 'session.created': {
        const location = data.location as { directory?: string } | undefined;
        await core.startSession(sessionID, location?.directory);
        break;
      }
      case 'session.text.ended': {
        const messageID = data.assistantMessageID;
        if (typeof messageID !== 'string' || typeof data.text !== 'string') return;
        // Each text part ends once with its full value; a message can hold
        // several parts, which arrive in ordinal order.
        const previous = core.takeBufferedText(messageID);
        const text = previous ? `${previous}\n\n${data.text}` : data.text;
        core.bufferText(sessionID, messageID, text, 'replace');
        break;
      }
      // V2's turn boundary. V1's `session.idle` (deprecated in V2 and not
      // relied on here) mapped to session-end at the same point.
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        await core.endSession(sessionID);
        break;
      case 'session.deleted':
        await core.endSession(sessionID);
        ownSessions.delete(sessionID);
        break;
    }
  };

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (event && typeof event.type === 'string') await handleEvent(event);
        } catch (err) {
          log(`event handler crash: ${errorMessage(err)}`);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) log(`event subscription ended: ${errorMessage(err)}`);
    }
  })();

  return async () => {
    controller.abort();
    await Promise.allSettled(registrations.map((r) => r.dispose()));
    core.close();
  };
}

// One entrypoint for both hosts: OpenCode V2 validates `{ id, setup }` and
// ignores `server`; OpenCode V1 (>= 1.18.29) loads `server`.
export default {
  id: 'cavemem',
  setup,
  server,
};
