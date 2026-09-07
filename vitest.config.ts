import { defineConfig } from 'vitest/config';
import { srcAliases } from './vitest.shared';

// Root config for packages that don't declare their own `vitest.config.ts`:
// Vitest discovers this via parent-directory lookup. Packages with a local
// config import `srcAliases` directly (see apps/cli, packages/storage,
// packages/embedding).
export default defineConfig({
  resolve: { alias: srcAliases },
});
