import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Fixtures are large; parsing the full page in several tests needs headroom.
    testTimeout: 20_000,
  },
});
