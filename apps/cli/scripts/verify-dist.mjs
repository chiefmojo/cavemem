#!/usr/bin/env node
// Refuses to publish a dist that was not rebuilt for this version. 0.4.4 shipped
// the 0.4.3 build because nothing in `changeset publish` runs a build; the root
// `release` script now does, and this guard (wired into `prepublishOnly`) catches
// any path that still skips it. Only version-stale builds are caught: a source
// change published without a version bump would pass, but every release goes
// through `changeset version`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function verifyDist(cliRoot) {
  const failures = [];
  const { version } = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'));

  const entry = join(cliRoot, 'dist', 'index.js');
  if (!existsSync(entry)) {
    failures.push('dist/index.js missing; run `pnpm build` before publishing');
  } else {
    let built;
    try {
      built = execFileSync(process.execPath, [entry, '--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      failures.push(`dist/index.js --version failed: ${err.message.split('\n')[0]}`);
    }
    if (built !== undefined && built !== version) {
      failures.push(
        `dist/index.js reports ${built} but package.json is ${version}; run \`pnpm build\``,
      );
    }
  }

  // ScanClient resolves the thread entry as ./scan-thread.js next to its own chunk.
  if (!existsSync(join(cliRoot, 'dist', 'scan-thread.js'))) {
    failures.push('dist/scan-thread.js missing; run `pnpm build` before publishing');
  }

  // Same predicate as e2e-publish.sh step 6b.
  const bridge = join(cliRoot, 'dist', 'opencodeBridge.js');
  if (!existsSync(bridge)) {
    failures.push('dist/opencodeBridge.js missing; run `pnpm build` before publishing');
  } else {
    const mod = await import(pathToFileURL(bridge).href);
    const exports = Object.keys(mod);
    const def = mod.default;
    if (
      exports.length !== 1 ||
      exports[0] !== 'default' ||
      typeof def?.id !== 'string' ||
      typeof def.setup !== 'function' ||
      typeof def.server !== 'function'
    ) {
      failures.push(
        'dist/opencodeBridge.js is not a sole default { id, setup, server } plugin definition',
      );
    }
  }

  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const failures = await verifyDist(cliRoot);
  for (const failure of failures) process.stderr.write(`verify-dist: ${failure}\n`);
  if (failures.length > 0) process.exit(1);
  process.stdout.write('verify-dist: dist matches package version\n');
}
