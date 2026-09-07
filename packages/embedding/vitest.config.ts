import { defineConfig } from 'vitest/config';
import { srcAliases } from '../../vitest.shared';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
  resolve: { alias: srcAliases },
});
