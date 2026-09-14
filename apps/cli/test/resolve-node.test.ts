import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as resolve from '../src/util/resolve.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'cavemem-node-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function binary(path: string): string {
  fs.mkdirSync(join(path, '..'), { recursive: true });
  fs.writeFileSync(path, '', { mode: 0o755 });
  return path;
}

describe('stable installer Node path', () => {
  it.each(['\\tools', '/tools'])(
    'rejects drive-dependent Windows PATH root %s and keeps a later UNC candidate',
    (rooted) => {
      const execPath = 'C:\\Runtime\\node.exe';
      vi.spyOn(fs, 'realpathSync').mockReturnValue(execPath);
      vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);
      vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
      expect(
        resolve.resolveNodePath({
          execPath,
          platform: 'win32',
          path: `${rooted};\\\\server\\share\\tools`,
        }),
      ).toBe('\\\\server\\share\\tools\\node.exe');
      expect(resolve.resolveNodePath({ execPath, platform: 'win32', path: rooted })).toBe(execPath);
    },
  );

  it('preserves a Homebrew PATH symlink to the running Cellar interpreter', () => {
    const execPath = binary(join(dir, 'Cellar/node/24.1.0/bin/node'));
    fs.mkdirSync(join(dir, 'bin'));
    fs.symlinkSync(execPath, join(dir, 'bin/node'));
    expect(resolve.resolveNodePath({ execPath, path: join(dir, 'bin') })).toBe(
      join(dir, 'bin/node'),
    );
  });

  it('finds the Homebrew prefix symlink when the install PATH omits it', () => {
    const execPath = binary(join(dir, 'Cellar/node@24/24.1.0/bin/node'));
    fs.mkdirSync(join(dir, 'bin'));
    fs.symlinkSync(execPath, join(dir, 'bin/node'));
    expect(resolve.resolveNodePath({ execPath, path: '' })).toBe(join(dir, 'bin/node'));
  });

  it('skips unrelated, missing, empty, and relative PATH candidates in order', () => {
    const execPath = binary(join(dir, 'runtime/node'));
    binary(join(dir, 'other/node'));
    fs.mkdirSync(join(dir, 'first'));
    fs.mkdirSync(join(dir, 'second'));
    fs.symlinkSync(execPath, join(dir, 'first/node'));
    fs.symlinkSync(execPath, join(dir, 'second/node'));
    const path = [
      '',
      '.',
      'relative',
      join(dir, 'missing'),
      join(dir, 'other'),
      join(dir, 'first'),
      join(dir, 'second'),
    ].join(':');
    expect(resolve.resolveNodePath({ execPath, path })).toBe(join(dir, 'first/node'));
  });

  it('falls back to process.execPath when no usable matching candidate exists', () => {
    const execPath = binary(join(dir, 'runtime/node'));
    fs.mkdirSync(join(dir, 'bad'));
    fs.symlinkSync(execPath, join(dir, 'bad/node'));
    fs.chmodSync(execPath, 0o644);
    expect(
      resolve.resolveNodePath({ execPath, path: `${join(dir, 'bad')}:${join(dir, 'missing')}` }),
    ).toBe(execPath);
    expect(resolve.resolveNodePath({ execPath, path: '' })).toBe(execPath);
  });

  it('handles Windows PATH delimiters, quoted absolute entries, spaces, and case-insensitive realpaths', () => {
    const execPath = 'C:\\Runtime\\node.exe';
    vi.spyOn(fs, 'realpathSync').mockImplementation((p) => {
      if (p === execPath) return 'C:\\Runtime\\node.exe';
      if (p === 'C:\\Program Files\\nodejs\\node.exe') return 'c:\\runtime\\node.exe';
      throw new Error('ENOENT');
    });
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
    expect(
      resolve.resolveNodePath({
        execPath,
        platform: 'win32',
        path: ';relative;C:relative;"C:\\Program Files\\nodejs";C:\\other',
      }),
    ).toBe('C:\\Program Files\\nodejs\\node.exe');
  });
});
