import { fileURLToPath } from 'node:url';

/**
 * Resolve workspace packages to their source entry points so Vitest tests
 * exercise source, not `dist` (gitignored and only present after a build).
 *
 * Keep this list in sync with the `paths` map in `tsconfig.base.json`.
 */
const toSrc = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export const srcAliases = [
  { find: '@cavemem/compress', replacement: toSrc('./packages/compress/src/index.ts') },
  { find: '@cavemem/config', replacement: toSrc('./packages/config/src/index.ts') },
  { find: '@cavemem/core', replacement: toSrc('./packages/core/src/index.ts') },
  { find: '@cavemem/embedding', replacement: toSrc('./packages/embedding/src/index.ts') },
  { find: '@cavemem/storage', replacement: toSrc('./packages/storage/src/index.ts') },
  { find: '@cavemem/hooks', replacement: toSrc('./packages/hooks/src/index.ts') },
  { find: '@cavemem/installers', replacement: toSrc('./packages/installers/src/index.ts') },
  { find: '@cavemem/mcp-server', replacement: toSrc('./apps/mcp-server/src/server.ts') },
  { find: '@cavemem/worker', replacement: toSrc('./apps/worker/src/server.ts') },
];
