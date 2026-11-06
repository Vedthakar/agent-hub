import { defineConfig } from 'vitest/config';

const shared = { testTimeout: 60_000, hookTimeout: 60_000, env: { LOG_LEVEL: 'error' } };

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/main.ts'],
      reporter: ['text-summary', 'text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
    },
    projects: [
      // Offline: pure logic, plus in-process PGlite where a real SQL engine is needed.
      { test: { ...shared, name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      // Router golden tests: recorded worker replies, fixed clock, fresh PGlite per case.
      { test: { ...shared, name: 'golden', include: ['test/golden/**/*.test.ts'] } },
      // Integration, end-to-end and RLS tests on local Supabase (`supabase start`).
      {
        test: {
          ...shared,
          name: 'supabase',
          include: ['test/integration/**/*.test.ts', 'test/e2e/**/*.test.ts', 'test/supabase/**/*.test.ts', 'test/security/**/*.test.ts'],
          globalSetup: ['test/support/globalSetup.ts'],
          maxWorkers: 4,
          // Runs after the offline projects, with its own worker cap (each worker holds DB connections).
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
