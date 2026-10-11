import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCode } from '../src/opencode.js';
import type { InstallContext } from '../src/types.js';
import { writeFakeOpenCode } from './fake-opencode.js';

const ENV_KEYS = [
  'PATH',
  'XDG_CONFIG_HOME',
  'FAKE_OPENCODE_OUTPUT',
  'FAKE_OPENCODE_FAILURE',
  'FAKE_OPENCODE_VERSION',
] as const;

// `opencode debug config` on OpenCode 2 lists configuration sources, lowest
// to highest precedence, each with a normalized `info` (mcp.servers, disabled).
function source(path: string | undefined, cavemem?: unknown) {
  return {
    type: 'document',
    ...(path ? { path } : {}),
    info: { mcp: { servers: cavemem === undefined ? {} : { cavemem } } },
  };
}

describe('OpenCode 2 effective configuration verification', () => {
  let home: string;
  let saved: Record<string, string | undefined>;
  let ctx: InstallContext;
  const verified = () => `verified effective OpenCode MCP configuration in ${process.cwd()}`;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cavemem-opencode-v2-'));
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.FAKE_OPENCODE_VERSION = 'opencode v2.0.26';

    const fakeDist = join(home, 'cavemem', 'dist');
    mkdirSync(fakeDist, { recursive: true });
    writeFileSync(join(fakeDist, 'opencodeBridge.js'), '// fake bridge\n');
    ctx = {
      ideConfigDir: home,
      cliPath: join(fakeDist, 'index.js'),
      nodeBin: '/stable/bin/node',
      dataDir: join(home, 'data'),
      platform: process.platform,
    };
    process.env.PATH = `${writeFakeOpenCode(home)}${delimiter}${saved.PATH ?? ''}`;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('verifies the local entry the installer wrote, read from the source list', async () => {
    const messages = await openCode.install(ctx);

    expect(messages).toContain(verified());
    expect(messages.join('\n')).not.toContain('could not read effective configuration');
  });

  it('verifies a remote entry whose header values OpenCode masks, without exposing the token', async () => {
    const token = 'remote-super-secret';
    const messages = await openCode.install({
      ...ctx,
      remote: { url: 'https://memory.example', token },
    });

    expect(messages).toContain(verified());
    expect(messages.join('\n')).not.toContain(token);
  });

  it('warns and names the source when a later source overrides the entry', async () => {
    const globalPath = join(home, '.config', 'opencode', 'opencode.json');
    const projectPath = join(home, 'project', 'opencode.json');
    const intended = {
      type: 'local',
      command: ['/stable/bin/node', ctx.cliPath, 'mcp'],
      disabled: false,
    };
    process.env.FAKE_OPENCODE_OUTPUT = JSON.stringify([
      source(globalPath, intended),
      { type: 'directory', path: join(home, '.config', 'opencode') },
      source(projectPath, { type: 'local', command: ['other'], disabled: false }),
    ]);

    const messages = await openCode.install(ctx);

    const warning = messages.find((m) => m.includes('effective mcp.cavemem differs'));
    expect(warning).toBeDefined();
    expect(warning).toContain(`(set by ${projectPath})`);
    expect(messages).not.toContain(verified());
  });

  it('verifies when an earlier source differs but the last one matches', async () => {
    const intended = {
      type: 'local',
      command: ['/stable/bin/node', ctx.cliPath, 'mcp'],
      disabled: false,
    };
    process.env.FAKE_OPENCODE_OUTPUT = JSON.stringify([
      source('/a/opencode.json', { type: 'local', command: ['older'], disabled: false }),
      source('/b/opencode.json', intended),
    ]);

    expect(await openCode.install(ctx)).toContain(verified());
  });

  it('warns when the effective entry is disabled by a later source', async () => {
    process.env.FAKE_OPENCODE_OUTPUT = JSON.stringify([
      source('/g/opencode.json', {
        type: 'local',
        command: ['/stable/bin/node', ctx.cliPath, 'mcp'],
        disabled: false,
      }),
      source('/p/opencode.json', {
        type: 'local',
        command: ['/stable/bin/node', ctx.cliPath, 'mcp'],
        disabled: true,
      }),
    ]);

    const messages = await openCode.install(ctx);

    expect(messages.some((m) => m.includes('differs') && m.includes('(set by /p/'))).toBe(true);
  });

  it('warns that no source defines mcp.cavemem', async () => {
    process.env.FAKE_OPENCODE_OUTPUT = JSON.stringify([source('/g/opencode.json')]);

    const messages = await openCode.install(ctx);

    expect(messages).toContain(
      `warning: OpenCode MCP verification in ${process.cwd()}: no configuration source reported by \`opencode debug config\` defines mcp.cavemem. Cavemem installation completed; other OpenCode configuration sources were left unchanged.`,
    );
  });

  it.each(['not-json remote-super-secret', '{"mcp":{"cavemem":{}}}'])(
    'warns, naming the OpenCode 2 command and not --pure, for unusable output %j',
    async (output) => {
      process.env.FAKE_OPENCODE_OUTPUT = output;

      const messages = await openCode.install(ctx);

      expect(messages).toContain(
        `warning: OpenCode MCP verification in ${process.cwd()} could not read effective configuration with \`opencode debug config\`. Cavemem installation completed; other OpenCode configuration sources were left unchanged.`,
      );
      expect(messages.join('\n')).not.toContain('remote-super-secret');
      expect(messages.join('\n')).not.toContain('--pure');
    },
  );
});
