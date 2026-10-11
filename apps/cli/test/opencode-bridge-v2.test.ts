import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

const TOOLS_NOTICE =
  'You have cavemem memory tools (search, timeline, get_observations, list_sessions). Use them when past context would help.';
const TOOLS_UNAVAILABLE =
  'Cavemem memory tools are unavailable in this OpenCode session because the Cavemem MCP connection is not available.';
const TOOLS_STATUS_UNKNOWN =
  'Cavemem memory tool availability could not be determined for this OpenCode session.';

const DIR = '/proj';

interface V2Event {
  type: string;
  location?: { directory: string };
  data: Record<string, unknown>;
}

type HookCallback = (event: never) => Promise<void>;

/** Push-driven async iterable standing in for `ctx.event.subscribe()`. */
function eventStream() {
  const queue: V2Event[] = [];
  let wake: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const iterable: AsyncIterable<V2Event> = {
    async *[Symbol.asyncIterator]() {
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    },
  };
  return {
    subscribe: vi.fn((options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return iterable;
    }),
    push(event: V2Event) {
      queue.push(event);
      wake?.();
    },
    get aborted() {
      return signal?.aborted ?? false;
    },
  };
}

function fakeContext(mcpData: Array<{ name: string; status: { status: string } }> = []) {
  const events = eventStream();
  const hooks = new Map<string, HookCallback>();
  const dispose = vi.fn(async () => {});
  const register = (name: string, cb: HookCallback) => {
    hooks.set(name, cb);
    return Promise.resolve({ dispose });
  };
  const mcpList = vi.fn(async () => ({ location: { directory: DIR }, data: mcpData }));
  const ctx = {
    location: { directory: DIR },
    event: { subscribe: events.subscribe },
    session: { hook: (name: string, cb: HookCallback) => register(`session.${name}`, cb) },
    tool: { hook: (name: string, cb: HookCallback) => register(`tool.${name}`, cb) },
    mcp: { list: mcpList },
  };
  const call = (name: string, event: unknown) =>
    (hooks.get(name) as (event: unknown) => Promise<void>)(event);
  return { ctx, events, call, dispose, mcpList };
}

/** Records each `cavemem hook run <name>` dispatch with its stdin payload. */
async function captureHooks() {
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const childProcess = await import('node:child_process');
  vi.spyOn(childProcess, 'spawn').mockImplementation(((_cmd: string, args: string[]) => {
    const name = args[args.indexOf('run') + 1] as string;
    return {
      on: () => {},
      stdin: {
        on: () => {},
        end: (body: string) => calls.push({ name, payload: JSON.parse(body) }),
      },
      unref: () => {},
    } as unknown as ChildProcess;
  }) as never);
  return calls;
}

// Lets the bridge's background event loop drain what was pushed.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('opencode-bridge V2 setup', () => {
  let home: string;
  let origHome: string | undefined;
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cavemem-bridge-v2-'));
    origHome = process.env.CAVEMEM_HOME;
    process.env.CAVEMEM_HOME = home;
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ embedding: { provider: 'none' } }));
    vi.resetModules();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    if (origHome === undefined) delete process.env.CAVEMEM_HOME;
    else process.env.CAVEMEM_HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function setup(fake: ReturnType<typeof fakeContext>) {
    const mod = await import('../src/opencode-bridge.js');
    const cleanup = await mod.default.setup(fake.ctx as never);
    cleanups.push(cleanup);
    return cleanup;
  }

  it('captures a full turn through the V2 events and hooks', async () => {
    const calls = await captureHooks();
    const fake = fakeContext();
    await setup(fake);

    fake.events.push({
      type: 'session.created',
      location: { directory: DIR },
      data: { sessionID: 'ses-1', location: { directory: DIR } },
    });
    await settle();
    await fake.call('session.prompt', {
      sessionID: 'ses-1',
      messageID: 'msg-1',
      prompt: { text: '  fix the build  ' },
    });
    await fake.call('tool.execute.after', {
      tool: 'shell',
      sessionID: 'ses-1',
      input: { command: 'echo ok' },
      status: 'completed',
      result: { output: { exit: 0 }, content: [{ type: 'text', text: 'ok\n' }] },
    });
    for (const [ordinal, text] of ['first part', 'second part'].entries()) {
      fake.events.push({
        type: 'session.text.ended',
        location: { directory: DIR },
        data: { sessionID: 'ses-1', assistantMessageID: 'msg-2', ordinal, text },
      });
    }
    // The turn boundary carries no location.
    fake.events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses-1' } });
    await settle();

    expect(calls).toEqual([
      { name: 'session-start', payload: { session_id: 'ses-1', ide: 'opencode', cwd: DIR } },
      { name: 'user-prompt-submit', payload: { session_id: 'ses-1', prompt: 'fix the build' } },
      {
        name: 'post-tool-use',
        payload: {
          session_id: 'ses-1',
          tool_name: 'shell',
          tool_input: '{"command":"echo ok"}',
          tool_response: 'ok\n',
        },
      },
      {
        name: 'stop',
        payload: { session_id: 'ses-1', turn_summary: 'first part\n\nsecond part' },
      },
      { name: 'session-end', payload: { session_id: 'ses-1' } },
    ]);
  });

  it('ignores sessions from other locations, including their location-less turn ends', async () => {
    const calls = await captureHooks();
    const fake = fakeContext();
    await setup(fake);

    fake.events.push({
      type: 'session.created',
      location: { directory: '/other' },
      data: { sessionID: 'ses-x', location: { directory: '/other' } },
    });
    fake.events.push({
      type: 'session.text.ended',
      location: { directory: '/other' },
      data: { sessionID: 'ses-x', assistantMessageID: 'msg-x', ordinal: 0, text: 'not ours' },
    });
    fake.events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses-x' } });
    await settle();

    expect(calls).toEqual([]);
  });

  it('records a failed tool call with its error as the response', async () => {
    const calls = await captureHooks();
    const fake = fakeContext();
    await setup(fake);

    await fake.call('tool.execute.after', {
      tool: 'read',
      sessionID: 'ses-1',
      input: { filePath: '/missing' },
      status: 'error',
      error: { message: 'not found' },
    });

    expect(calls).toEqual([
      {
        name: 'post-tool-use',
        payload: {
          session_id: 'ses-1',
          tool_name: 'read',
          tool_input: '{"filePath":"/missing"}',
          tool_response: '{"message":"not found"}',
        },
      },
    ]);
  });

  it.each([
    ['connected', TOOLS_NOTICE],
    ['failed', TOOLS_UNAVAILABLE],
    ['pending', TOOLS_STATUS_UNKNOWN],
  ])('injects the %s MCP status as a system text part', async (status, expected) => {
    await captureHooks();
    const fake = fakeContext([{ name: 'cavemem', status: { status } }]);
    await setup(fake);

    const event = { sessionID: 'ses-1', system: [{ type: 'text', text: 'base' }] };
    await fake.call('session.context', event);

    expect(fake.mcpList).toHaveBeenCalledWith({ location: { directory: DIR } });
    expect(event.system).toEqual([
      { type: 'text', text: 'base' },
      { type: 'text', text: expected },
    ]);
  });

  it('treats a cavemem server missing from the MCP list as unavailable', async () => {
    await captureHooks();
    const fake = fakeContext([{ name: 'github', status: { status: 'connected' } }]);
    await setup(fake);

    const event = { sessionID: 'ses-1', system: [] as Array<{ type: string; text: string }> };
    await fake.call('session.context', event);

    expect(event.system).toEqual([{ type: 'text', text: TOOLS_UNAVAILABLE }]);
  });

  it('cleanup stops the event subscription and disposes every hook', async () => {
    await captureHooks();
    const fake = fakeContext();
    const cleanup = await setup(fake);

    await cleanup();

    expect(fake.events.aborted).toBe(true);
    expect(fake.dispose).toHaveBeenCalledTimes(3);
  });
});
