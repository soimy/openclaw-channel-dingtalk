import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['plugin.ts', 'utils.ts'],
      exclude: ['node_modules', 'test.ts'],
    },
  },
});
