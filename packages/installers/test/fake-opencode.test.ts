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

    if (process.platform === 'win32') {
      expect(readFileSync(join(bin, 'opencode.cmd'), 'utf8')).toContain('%*');
      return;
    }

    const executable = join(bin, 'opencode');
    expect(readFileSync(executable, 'utf8')).toMatch(/^#!\/bin\/sh\n/);
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
