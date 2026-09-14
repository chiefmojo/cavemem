import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shellQuote } from '../src/fs-utils.js';
import * as fsUtils from '../src/fs-utils.js';
import { type IdeName, getInstaller } from '../src/index.js';
import type { InstallContext } from '../src/types.js';

let dir: string;
let ctx: InstallContext;
const mcpCases: [IdeName, string, string][] = [
  ['claude-code', '.claude.json', 'mcpServers'],
  ['gemini-cli', '.gemini/settings.json', 'mcpServers'],
  ['opencode', '.config/opencode/opencode.json', 'mcp'],
  ['codex', '.codex/config.toml', 'mcp_servers'],
  ['cursor', '.cursor/mcp.json', 'mcpServers'],
  ['copilot', '.config/Code/User/mcp.json', 'servers'],
  ['augment', '.augment/settings.json', 'mcpServers'],
  ['antigravity', '.gemini/config/mcp_config.json', 'mcpServers'],
  ['bob', '.bob/mcp.json', 'mcpServers'],
];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-diagnose-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, '.config'));
  vi.stubEnv('APPDATA', join(dir, 'AppData/Roaming'));
  ctx = {
    ideConfigDir: dir,
    cliPath: join(dir, 'cli/index.js'),
    nodeBin: process.execPath,
    dataDir: join(dir, 'data'),
  };
  write('cli/opencodeBridge.js', '// fixture');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, value: unknown): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
}

function mcpFixture(ide: IdeName, originalFile: string, key: string, command: string | null): void {
  let file = originalFile;
  if (ide === 'copilot' && process.platform === 'darwin')
    file = 'Library/Application Support/Code/User/mcp.json';
  if (ide === 'copilot' && process.platform === 'win32')
    file = 'AppData/Roaming/Code/User/mcp.json';
  const entry =
    command === null
      ? { url: 'http://localhost:37777/mcp', headers: { Authorization: 'secret-token' } }
      : ide === 'opencode'
        ? { type: 'local', command: [command, ctx.cliPath, 'mcp'] }
        : { command, args: [ctx.cliPath, 'mcp'] };
  if (ide === 'codex') {
    write(
      file,
      command === null
        ? '[mcp_servers.cavemem]\nurl = "http://localhost:37777/mcp"\n'
        : `[mcp_servers.cavemem]\ncommand = ${JSON.stringify(command)}\nargs = ["mcp"]\n`,
    );
  } else
    write(file, {
      userSecret: 'secret-token',
      [key]: {
        unrelated: { command: '/deleted/user/node', env: { TOKEN: 'secret-token' } },
        cavemem: entry,
      },
    });
}

function snapshot(path = dir): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(path)) return result;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(result, snapshot(full));
    else result[full] = `${statSync(full).mode}:${readFileSync(full, 'utf8')}`;
  }
  return result;
}

describe.each(mcpCases)('%s interpreter diagnostics', (ide, file, key) => {
  it('reports a deleted persisted Node with the exact IDE repair command, without mutation or secrets', async () => {
    mcpFixture(ide, file, key, join(dir, 'deleted/node'));
    const before = snapshot();
    const result = await getInstaller(ide).diagnose(ctx);
    expect(result).toEqual([
      expect.objectContaining({
        ide,
        code: 'node-missing',
        remedy: `cavemem install --ide ${ide}`,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(snapshot()).toEqual(before);
  });

  it('warns on an existing version-pinned Homebrew Cellar interpreter', async () => {
    write('Cellar/node@24/24.1.0/bin/node', '');
    const node = join(dir, 'Cellar/node@24/24.1.0/bin/node');
    chmodSync(node, 0o755);
    mcpFixture(ide, file, key, node);
    expect(await getInstaller(ide).diagnose(ctx)).toEqual([
      expect.objectContaining({ code: 'node-fragile', ide }),
    ]);
  });

  it('accepts a valid interpreter and ignores unrelated user commands', async () => {
    mcpFixture(ide, file, key, process.execPath);
    expect(await getInstaller(ide).diagnose(ctx)).toEqual([]);
  });

  it('has nothing to check for absent configs or a remote entry without local hooks', async () => {
    expect(await getInstaller(ide).diagnose(ctx)).toEqual([]);
    mcpFixture(ide, file, key, null);
    const before = snapshot();
    expect(
      await getInstaller(ide).diagnose({
        ...ctx,
        remote: { url: 'http://localhost:37777', token: 'secret-token' },
      }),
    ).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('reinstall repairs stale owned entries while preserving user content', async () => {
    mcpFixture(ide, file, key, join(dir, 'deleted/node'));
    await getInstaller(ide).install(ctx);
    expect(await getInstaller(ide).diagnose(ctx)).toEqual([]);
    if (ide !== 'codex') {
      const actualFile =
        ide === 'copilot' && process.platform === 'darwin'
          ? 'Library/Application Support/Code/User/mcp.json'
          : ide === 'copilot' && process.platform === 'win32'
            ? 'AppData/Roaming/Code/User/mcp.json'
            : file;
      expect(JSON.parse(readFileSync(join(dir, actualFile), 'utf8')).userSecret).toBe(
        'secret-token',
      );
    }
  });
});

describe('persisted capture interpreters', () => {
  it.each([
    [
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Me\\cavemem\\index.js" hook run stop --ide codex',
      'codex',
      'C:\\Program Files\\nodejs\\node.exe',
    ],
    [
      '"/missing/with\\"quote/node" /opt/cavemem/index.js hook run stop --ide claude-code',
      'claude-code',
      '/missing/with"quote/node',
    ],
    ['exec "/old/node" "/old/cli.js" hook run stop --ide augment', 'augment', '/old/node'],
  ])('decodes emitted command %s without losing the interpreter path', (command, ide, nodeBin) => {
    expect(fsUtils.parseCavememHook(command, ide)).toEqual({ nodeBin, event: 'stop' });
  });
  it('does not claim an echo command that prints a Cavemem-shaped argument list', () => {
    expect(
      fsUtils.parseCavememHook('echo /tmp/report.js hook run stop --ide codex', 'codex'),
    ).toBeUndefined();
  });
  it('recognizes the legacy direct-JavaScript hook shape without inventing a Node path', () => {
    expect(
      fsUtils.parseCavememHook(
        '/old/cavemem/index.js hook run stop --ide claude-code',
        'claude-code',
      ),
    ).toEqual({ event: 'stop' });
  });
  it('recognizes an unquoted legacy Windows direct-JavaScript hook', () => {
    expect(
      fsUtils.parseCavememHook(
        String.raw`C:\Users\Me\cavemem\index.js hook run stop --ide claude-code`,
        'claude-code',
      ),
    ).toEqual({ event: 'stop' });
  });
  describe.each([
    ['claude-code', '.claude/settings.json', true],
    ['codex', '.codex/hooks.json', true],
    ['copilot', '.copilot/hooks/cavemem.json', false],
  ] as const)('%s command ownership', (ide, file, grouped) => {
    const makeConfig = (command: string) => ({
      hooks: {
        Stop: [
          grouped
            ? { matcher: 'user', hooks: [{ type: 'command', command }] }
            : { type: 'command', command },
        ],
      },
    });
    it.each(['label', 'wrong-ide'] as const)(
      'ignores foreign %s commands during diagnosis',
      async (kind) => {
        const command =
          kind === 'label'
            ? '/missing/node /tmp/user/report.js --label "hook run stop failed"'
            : '/missing/node /tmp/user/report.js hook run stop --ide foreign-tool';
        write(file, makeConfig(command));
        expect(await getInstaller(ide).diagnose(ctx)).toEqual([]);
      },
    );
    it.each(['install', 'uninstall'] as const)(
      '%s preserves foreign commands containing hook text in an argument',
      async (operation) => {
        const command = '/missing/node /tmp/user/report.js --label "hook run stop failed"';
        write(file, makeConfig(command));
        await getInstaller(ide)[operation](ctx);
        const hooks = JSON.parse(readFileSync(join(dir, file), 'utf8')).hooks.Stop;
        expect(hooks).toContainEqual(
          grouped
            ? { matcher: 'user', hooks: [{ type: 'command', command }] }
            : { type: 'command', command },
        );
      },
    );
    it('diagnoses an escaped double quote in a remote hook interpreter', async () => {
      const node = join(dir, 'missing/with"quote/node');
      write(
        file,
        makeConfig(`${shellQuote(node)} ${shellQuote(ctx.cliPath)} hook run stop --ide ${ide}`),
      );
      expect(
        await getInstaller(ide).diagnose({
          ...ctx,
          remote: { url: 'http://localhost:37777', token: 'secret-token' },
        }),
      ).toEqual([expect.objectContaining({ code: 'node-missing', ide })]);
    });
    it.each(['install', 'uninstall'] as const)(
      '%s removes a legacy direct-JavaScript Cavemem hook',
      async (operation) => {
        const command = `/old/cavemem/index.js hook run stop --ide ${ide}`;
        write(file, makeConfig(command));
        await getInstaller(ide)[operation](ctx);
        const configPath = join(dir, file);
        const hooks = existsSync(configPath)
          ? (JSON.parse(readFileSync(configPath, 'utf8')).hooks?.Stop ?? [])
          : [];
        const commands = grouped
          ? hooks.flatMap((group: { hooks?: Array<{ command?: string }> }) => group.hooks ?? [])
          : hooks;
        expect(commands.map((hook: { command?: string }) => hook.command)).not.toContain(command);
      },
    );
    it.each(['install', 'uninstall'] as const)(
      '%s removes an unquoted legacy Windows direct-JavaScript Cavemem hook',
      async (operation) => {
        const command = String.raw`C:\Users\Me\cavemem\index.js hook run stop --ide ${ide}`;
        write(file, makeConfig(command));
        await getInstaller(ide)[operation](ctx);
        const configPath = join(dir, file);
        const hooks = existsSync(configPath)
          ? (JSON.parse(readFileSync(configPath, 'utf8')).hooks?.Stop ?? [])
          : [];
        const commands = grouped
          ? hooks.flatMap((group: { hooks?: Array<{ command?: string }> }) => group.hooks ?? [])
          : hooks;
        expect(commands.map((hook: { command?: string }) => hook.command)).not.toContain(command);
      },
    );
  });

  describe.each([
    ['claude-code', '.claude/settings.json'],
    ['codex', '.codex/hooks.json'],
    ['augment', '.augment/settings.json'],
  ] as const)('%s mixed hook groups', (ide, file) => {
    it.each(['install', 'uninstall'] as const)(
      '%s retains user hooks and group metadata',
      async (operation) => {
        const userHook = { type: 'command', command: 'echo USER_HOOK', timeout: 17 };
        const userGroup = {
          matcher: 'user-only',
          hooks: [{ type: 'command', command: 'echo OTHER_USER_HOOK' }],
        };
        const cavememHook = {
          type: 'command',
          command:
            ide === 'augment'
              ? join(dir, '.augment/cavemem-hooks/post-tool-use.sh')
              : `"${join(dir, 'deleted/node')}" "${ctx.cliPath}" hook run post-tool-use --ide ${ide}`,
        };
        const metadata = { matcher: '.*', userMetadata: { preserve: true } };
        write(file, {
          hooks: {
            PostToolUse: [
              { ...metadata, hooks: [cavememHook, userHook] },
              { hooks: [cavememHook] },
              userGroup,
            ],
          },
        });

        await getInstaller(ide)[operation](ctx);

        const groups = JSON.parse(readFileSync(join(dir, file), 'utf8')).hooks.PostToolUse;
        expect(groups).toContainEqual({ ...metadata, hooks: [userHook] });
        expect(groups).toContainEqual(userGroup);
        expect(groups).toHaveLength(operation === 'install' ? 3 : 2);
        if (operation === 'install') expect(await getInstaller(ide).diagnose(ctx)).toEqual([]);
      },
    );
  });

  it('tolerates a malformed OpenCode sidecar without printing its contents', async () => {
    write('.config/opencode/cavemem-bridge.json', 'null');
    expect(await getInstaller('opencode').diagnose(ctx)).toEqual([]);
  });
  it.each([
    ['claude-code', '.claude/settings.json', true],
    ['codex', '.codex/hooks.json', true],
    ['copilot', '.copilot/hooks/cavemem.json', false],
  ] as const)(
    'checks %s hooks independently of remote MCP, including quoted paths',
    async (ide, file, grouped) => {
      const hook = {
        type: 'command',
        command: `"${join(dir, 'deleted path/node')}" "${ctx.cliPath}" hook run stop --ide ${ide}`,
      };
      write(file, { hooks: { Stop: [grouped ? { hooks: [hook] } : hook] } });
      const before = snapshot();
      expect(
        await getInstaller(ide).diagnose({
          ...ctx,
          remote: { url: 'http://localhost:37777', token: 'secret-token' },
        }),
      ).toEqual([expect.objectContaining({ ide, code: 'node-missing' })]);
      expect(snapshot()).toEqual(before);
    },
  );

  it('checks the active Windows command override instead of the POSIX command', async () => {
    write('.codex/hooks.json', {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `${process.execPath} cli.js hook run stop --ide codex`,
                commandWindows:
                  '"C:\\Deleted Node\\node.exe" "C:\\cli.js" hook run stop --ide codex',
              },
            ],
          },
        ],
      },
    });
    expect(await getInstaller('codex').diagnose({ ...ctx, platform: 'win32' })).toEqual([
      expect.objectContaining({ code: 'node-missing' }),
    ]);
  });

  it.each(['sh', 'cmd'])(
    'checks Augment registered %s wrappers without reading unrelated scripts',
    async (ext) => {
      const file = `.augment/cavemem-hooks/stop.${ext}`;
      write(
        file,
        ext === 'sh'
          ? `#!/bin/sh\nexec "${join(dir, 'deleted/node')}" "${ctx.cliPath}" hook run stop --ide augment\n`
          : '@echo off\r\n"C:\\Deleted Node\\node.exe" "C:\\cli.js" hook run stop --ide augment\r\n',
      );
      write('.augment/settings.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: join(dir, file) }] }] },
      });
      const before = snapshot();
      expect(
        await getInstaller('augment').diagnose({
          ...ctx,
          platform: ext === 'cmd' ? 'win32' : 'linux',
        }),
      ).toEqual([expect.objectContaining({ code: 'node-missing' })]);
      expect(snapshot()).toEqual(before);
    },
  );

  it('checks the OpenCode sidecar in remote mode', async () => {
    write('.config/opencode/cavemem-bridge.json', { nodeBin: join(dir, 'deleted/node') });
    expect(
      await getInstaller('opencode').diagnose({
        ...ctx,
        remote: { url: 'http://localhost:37777', token: 'secret-token' },
      }),
    ).toEqual([expect.objectContaining({ code: 'node-missing' })]);
  });

  it('treats directories and non-executable files as unusable interpreters', async () => {
    for (const node of [join(dir, 'directory/node'), join(dir, 'file/node')]) {
      if (node.includes('/directory/')) mkdirSync(node, { recursive: true });
      else write('file/node', '');
      mcpFixture('cursor', '.cursor/mcp.json', 'mcpServers', node);
      expect(await getInstaller('cursor').diagnose({ ...ctx, platform: 'linux' })).toEqual([
        expect.objectContaining({ code: 'node-missing' }),
      ]);
    }
  });
});
