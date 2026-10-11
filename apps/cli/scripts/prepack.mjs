#!/usr/bin/env node
// Stages README, LICENSE, and the portable hook stubs into apps/cli/ so the
// `files` allowlist in package.json picks them up. Wired through
// `prepublishOnly` and `stage-publish` (after verify-dist.mjs), not `prepack`,
// so a plain `npm pack` does not stage these files.
import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const repoRoot = resolve(cliRoot, '..', '..');

// The staged files live at the monorepo root, so outside a checkout of it
// (a copied or unpacked apps/cli) there is nothing to stage: skip silently.
if (!existsSync(join(repoRoot, 'pnpm-workspace.yaml'))) {
  process.stdout.write('prepack: not in source repo, skipping\n');
  process.exit(0);
}

const items = [
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE'],
  ['hooks-scripts', 'hooks-scripts'],
];

for (const [src, dest] of items) {
  const from = join(repoRoot, src);
  if (!existsSync(from)) {
    process.stderr.write(`prepack: missing source ${from}\n`);
    process.exit(1);
  }
  cpSync(from, join(cliRoot, dest), { recursive: true });
}

process.stdout.write('prepack: staged README, LICENSE, hooks-scripts\n');
