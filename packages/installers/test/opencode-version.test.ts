import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPENCODE_VERSION_UNREADABLE, openCode, openCodeVersionWarning } from '../src/opencode.js';
import type { InstallContext } from '../src/types.js';
import { writeFakeOpenCode } from './fake-opencode.js';

describe('openCodeVersionWarning', () => {
  it.each(['opencode v2.0.26', '1.18.29', '1.19.0', '1.18.30'])(
    'accepts %s, which loads the bridge',
    (output) => {
      expect(openCodeVersionWarning(output)).toBeNull();
    },
  );

  it.each([
    ['1.18.28', '1.18.28'],
    ['opencode v1.9.0', '1.9.0'],
    ['0.15.8', '0.15.8'],
  ])('warns for %s, which cannot load the bridge', (output, version) => {
    const warning = openCodeVersionWarning(output);
    expect(warning).toContain(`OpenCode ${version} cannot load the cavemem bridge`);
    expect(warning).toContain('1.18.29');
  });

  it.each([null, '', 'opencode dev'])('warns that %j is unreadable', (output) => {
    expect(openCodeVersionWarning(output)).toBe(OPENCODE_VERSION_UNREADABLE);
  });
});

describe('OpenCode install version check', () => {
  let home: string;
  let originalPath: string | undefined;
  let originalXdg: string | undefined;
  let originalVersion: string | undefined;
  let ctx: InstallContext;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cavemem-opencode-version-'));
    originalPath = process.env.PATH;
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalVersion = process.env.FAKE_OPENCODE_VERSION;
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
    process.env.PATH = `${writeFakeOpenCode(home)}${delimiter}${originalPath ?? ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalVersion === undefined) delete process.env.FAKE_OPENCODE_VERSION;
    else process.env.FAKE_OPENCODE_VERSION = originalVersion;
    rmSync(home, { recursive: true, force: true });
  });

  it('adds no warning for OpenCode 2', async () => {
    process.env.FAKE_OPENCODE_VERSION = 'opencode v2.0.26';
    const messages = await openCode.install(ctx);
    expect(
      messages.filter((m) => m.includes('OpenCode version') || m.includes('cannot load')),
    ).toEqual([]);
  });

  it('warns but still installs for an OpenCode 1 release older than 1.18.29', async () => {
    process.env.FAKE_OPENCODE_VERSION = '1.17.13';
    const messages = await openCode.install(ctx);
    expect(messages).toContain(openCodeVersionWarning('1.17.13'));
    expect(messages.some((m) => m.startsWith('symlinked bridge plugin'))).toBe(true);
  });

  it('warns when the version cannot be read', async () => {
    process.env.FAKE_OPENCODE_VERSION = 'fail';
    const messages = await openCode.install(ctx);
    expect(messages).toContain(OPENCODE_VERSION_UNREADABLE);
  });
});
