import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { srcAliases } from '../../vitest.shared';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  define: { __CAVEMEM_VERSION__: JSON.stringify(version) },
  resolve: { alias: srcAliases },
});
