/**
 * Vitest config for integration tests.
 *
 * Runs the full city pipeline per seed (~20-30s each).
 * Run separately from the main suite to avoid CPU contention:
 *   bunx vitest run --config vitest.integration.config.js
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.js'],
    testTimeout: 300000,  // 5 minutes per test
    hookTimeout: 300000,  // 5 minutes for beforeAll
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,  // run seeds sequentially, one at a time
      },
    },
  },
});
