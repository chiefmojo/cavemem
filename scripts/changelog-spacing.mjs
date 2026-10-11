#!/usr/bin/env node
// Runs after `changeset version`. With `"prettier": false` (needed so changesets
// stops reformatting old CHANGELOG entries), @changesets/cli 2.x writes the new
// entry unformatted: no blank line after `## <version>`, and whitespace-only
// lines inside multi-paragraph items. Upstream fixed the heading join in 3.0.0
// (changesets/changesets#2118); this covers 2.x. Only the newest entry is
// touched, so older entries stay byte-for-byte as released.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_HEADING = /^## \S/;

export function fixNewestEntry(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => VERSION_HEADING.test(line));
  if (start === -1) return text;
  let end = lines.findIndex((line, i) => i > start && VERSION_HEADING.test(line));
  if (end === -1) end = lines.length;

  const entry = lines.slice(start, end).map((line) => (line.trim() === '' ? '' : line));
  if (entry.length > 1 && entry[1] !== '') entry.splice(1, 0, '');

  return [...lines.slice(0, start), ...entry, ...lines.slice(end)].join('\n');
}

function workspaceChangelogs(repoRoot) {
  const dirs = ['evals'];
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(repoRoot, group))) dirs.push(join(group, name));
  }
  return dirs.map((dir) => join(repoRoot, dir, 'CHANGELOG.md')).filter((path) => existsSync(path));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const path of workspaceChangelogs(repoRoot)) {
    const before = readFileSync(path, 'utf8');
    const after = fixNewestEntry(before);
    if (after !== before) {
      writeFileSync(path, after);
      process.stdout.write(`changelog-spacing: fixed ${path.slice(repoRoot.length + 1)}\n`);
    }
  }
}
