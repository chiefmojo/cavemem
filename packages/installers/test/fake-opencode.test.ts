import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFakeOpenCode } from './fake-opencode.js';

describe('writeFakeOpenCode', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it('forwards arguments through a portable POSIX wrapper with quoted paths', () => {
    const home = mkdtempSync(join(tmpdir(), "cavemem-fake-opencode-o'pen-"));
    homes.push(home);
    const bin = writeFakeOpenCode(join(home, "path with 'quote'"));
    const script = join(bin, 'opencode.mjs');
    expect(readFileSync(script, 'utf8')).toContain("import { readFileSync } from 'node:fs';");

    if (process.platform === 'win32') {
      const wrapper = readFileSync(join(bin, 'opencode.cmd'), 'utf8');
      expect(wrapper).toContain('opencode.mjs');
      expect(wrapper).toContain('%*');
      return;
    }

    const executable = join(bin, 'opencode');
    expect(readFileSync(executable, 'utf8')).toMatch(/^#!\/bin\/sh\n/);
    expect(readFileSync(executable, 'utf8')).toContain('opencode.mjs');
    chmodSync(executable, 0o755);

    const result = spawnSync(executable, ['debug', 'config', '--pure'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        FAKE_OPENCODE_FAILURE: '',
        FAKE_OPENCODE_OUTPUT: '{"mcp":{}}',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
