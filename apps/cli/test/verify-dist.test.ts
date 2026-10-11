import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyDist } from '../scripts/verify-dist.mjs';

const GOOD_BRIDGE =
  'export default { id: "cavemem", setup: async () => {}, server: async () => ({}) };\n';

function writeCli(root: string, opts: { version: string; distVersion: string; bridge?: string }) {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: opts.version }));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'dist', 'index.js'),
    `process.stdout.write(${JSON.stringify(`${opts.distVersion}\n`)});\n`,
  );
  if (opts.bridge !== undefined) {
    writeFileSync(join(root, 'dist', 'opencodeBridge.js'), opts.bridge);
  }
}

describe('verifyDist', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cavemem-verify-dist-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a dist built from the current package version', async () => {
    writeCli(root, { version: '0.4.5', distVersion: '0.4.5', bridge: GOOD_BRIDGE });
    expect(await verifyDist(root)).toEqual([]);
  });

  it('rejects a dist built for an older version', async () => {
    // The 0.4.4 incident: package.json bumped, dist left at 0.4.3.
    writeCli(root, { version: '0.4.4', distVersion: '0.4.3', bridge: GOOD_BRIDGE });
    const failures = await verifyDist(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/0\.4\.3/);
    expect(failures[0]).toMatch(/0\.4\.4/);
  });

  it('rejects a missing dist', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.4.5' }));
    expect((await verifyDist(root)).length).toBeGreaterThanOrEqual(1);
  });

  it('reports a crashing CLI entry as a failure instead of throwing', async () => {
    writeCli(root, { version: '0.4.5', distVersion: '0.4.5', bridge: GOOD_BRIDGE });
    writeFileSync(join(root, 'dist', 'index.js'), 'process.exit(3);\n');
    const failures = await verifyDist(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/--version failed/);
  });

  it('rejects a bridge without the V1+V2 plugin definition', async () => {
    writeCli(root, {
      version: '0.4.5',
      distVersion: '0.4.5',
      bridge: 'export default async function plugin() { return {}; }\n',
    });
    const failures = await verifyDist(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/opencodeBridge/);
  });

  it('rejects a bridge with extra named exports', async () => {
    writeCli(root, {
      version: '0.4.5',
      distVersion: '0.4.5',
      bridge: `${GOOD_BRIDGE}export const helper = 1;\n`,
    });
    expect(await verifyDist(root)).toHaveLength(1);
  });
});
