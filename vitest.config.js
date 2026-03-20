import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Excludes test/integration/ — those run the full city pipeline (~20-30s per seed)
    // and need dedicated CPU. Run them separately:
    //   bunx vitest run --config vitest.integration.config.js
    include: ['test/{buildings,city,core,regional,rendering}/**/*.test.js'],
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
