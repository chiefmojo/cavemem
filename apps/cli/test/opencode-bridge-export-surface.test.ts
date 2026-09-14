import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as bridgeEntry from '../src/opencode-bridge.js';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('OpenCode bridge plugin export surface', () => {
  it('exposes only the default plugin factory from the source entry', () => {
    expect(Object.keys(bridgeEntry)).toEqual(['default']);
  });

  it('exposes only the default plugin factory from the built bundle', async () => {
    execFileSync('pnpm', ['build'], { cwd: packageDir, stdio: 'pipe' });

    const artifact = join(packageDir, 'dist', 'opencodeBridge.js');
    expect(existsSync(artifact)).toBe(true);

    const builtBridge = await import(`${pathToFileURL(artifact).href}?${Date.now()}`);
    expect(Object.keys(builtBridge)).toEqual(['default']);
  });
});
