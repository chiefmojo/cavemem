import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCode } from '../src/opencode.js';
import type { InstallContext } from '../src/types.js';
import { writeFakeOpenCode } from './fake-opencode.js';

describe('OpenCode effective configuration verification', () => {
  let home: string;
  let originalPath: string | undefined;
  let originalXdg: string | undefined;
  let originalOutput: string | undefined;
  let originalFailure: string | undefined;
  let ctx: InstallContext;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cavemem-opencode-effective-'));
    originalPath = process.env.PATH;
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalOutput = process.env.FAKE_OPENCODE_OUTPUT;
    originalFailure = process.env.FAKE_OPENCODE_FAILURE;
    delete process.env.FAKE_OPENCODE_OUTPUT;
    delete process.env.FAKE_OPENCODE_FAILURE;
    process.env.XDG_CONFIG_HOME = join(home, '.config');

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

    const bin = writeFakeOpenCode(home);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalOutput === undefined) delete process.env.FAKE_OPENCODE_OUTPUT;
    else process.env.FAKE_OPENCODE_OUTPUT = originalOutput;
    if (originalFailure === undefined) delete process.env.FAKE_OPENCODE_FAILURE;
    else process.env.FAKE_OPENCODE_FAILURE = originalFailure;
    rmSync(home, { recursive: true, force: true });
  });

  it('accepts the effective local MCP entry written by the installer', async () => {
    const messages = await openCode.install(ctx);

    expect(messages).toContain(`verified effective OpenCode MCP configuration in ${process.cwd()}`);
  });

  it('accepts the effective remote MCP entry without exposing its token', async () => {
    const token = 'remote-super-secret';
    const messages = await openCode.install({
      ...ctx,
      remote: { url: 'https://memory.example', token },
    });

    expect(messages).toContain(`verified effective OpenCode MCP configuration in ${process.cwd()}`);
    expect(messages.join('\n')).not.toContain(token);
  });

  it('warns about a shadowed entry and preserves project and unrelated global configuration', async () => {
    const projectConfig = join(home, 'project-opencode.json');
    writeFileSync(projectConfig, '{"mcp":{"cavemem":{"enabled":false}},"keep":"project"}\n');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      '{"theme":"dark","mcp":{"other":{"type":"local","command":["echo"]}}}\n',
    );
    process.env.FAKE_OPENCODE_OUTPUT = JSON.stringify({
      mcp: { cavemem: { type: 'local', command: ['remote-super-secret'], enabled: false } },
    });

    const messages = await openCode.install(ctx);

    expect(messages).toContain(
      `warning: OpenCode MCP verification in ${process.cwd()}: effective mcp.cavemem differs from the installed global entry. This may be an intentional project, managed, environment, or other configuration override; Cavemem left those sources unchanged.`,
    );
    expect(messages.join('\n')).not.toContain('remote-super-secret');

    expect(readFileSync(projectConfig, 'utf8')).toContain('"keep":"project"');
    const global = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    expect(global.theme).toBe('dark');
    expect(global.mcp.other).toBeDefined();
  });

  it('warns about malformed debug output without echoing it', async () => {
    process.env.FAKE_OPENCODE_OUTPUT = 'not-json remote-super-secret';

    const messages = await openCode.install(ctx);

    expect(messages).toContain(
      `warning: OpenCode MCP verification in ${process.cwd()} could not read effective configuration with \`opencode debug config --pure\`. Cavemem installation completed; other OpenCode configuration sources were left unchanged.`,
    );
    expect(messages.join('\n')).not.toContain('remote-super-secret');
  });

  it('warns about a failed debug command without echoing stderr', async () => {
    process.env.FAKE_OPENCODE_FAILURE = 'remote-super-secret';

    const messages = await openCode.install(ctx);

    expect(messages).toContain(
      `warning: OpenCode MCP verification in ${process.cwd()} could not read effective configuration with \`opencode debug config --pure\`. Cavemem installation completed; other OpenCode configuration sources were left unchanged.`,
    );
    expect(messages.join('\n')).not.toContain('remote-super-secret');
  });

  it('warns when the OpenCode command is unavailable after completing the install', async () => {
    process.env.PATH = join(home, 'missing-bin');

    const messages = await openCode.install(ctx);

    expect(messages).toContain(
      `warning: OpenCode MCP verification in ${process.cwd()} could not read effective configuration with \`opencode debug config --pure\`. Cavemem installation completed; other OpenCode configuration sources were left unchanged.`,
    );
    expect(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8')).toContain(
      '"cavemem"',
    );
  });
});
