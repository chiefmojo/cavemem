import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookSpawnCommand } from '../src/opencode-bridge.js';

// Windows: spawn() cannot execute a .js file directly — uv_spawn has no exec
// handler for it and fails with EFTYPE (same failure modes/worker.ts already
// guards against). The bridge must route .js entrypoints through the running
// JS runtime instead of spawning them raw.
describe('hookSpawnCommand', () => {
  it('wraps .js entrypoints in the current runtime', () => {
    const cli = join('C:', 'npm', 'node_modules', 'cavemem', 'dist', 'index.js');
    const { command, args } = hookSpawnCommand(cli);
    expect(command).toBe(process.execPath);
    expect(args).toEqual([cli]);
  });

  it('passes non-.js entrypoints (bin shims) through untouched', () => {
    const { command, args } = hookSpawnCommand('/usr/local/bin/cavemem');
    expect(command).toBe('/usr/local/bin/cavemem');
    expect(args).toEqual([]);
  });

  it('the returned command+args actually execute a .js fixture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cavemem-bridge-'));
    const fixture = join(dir, 'fixture.js');
    writeFileSync(fixture, 'process.stdout.write("ok")');
    const { command, args } = hookSpawnCommand(fixture);
    const exit = await new Promise<number | null>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, { stdio: 'ignore' });
      } catch (err) {
        reject(err);
        return;
      }
      child.on('error', reject);
      child.on('close', resolve);
    });
    expect(exit).toBe(0);
  });
});
