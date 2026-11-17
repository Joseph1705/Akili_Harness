import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Each server test creates its own PostgreSQL schema and runs every migration: allow for slow machines.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['plugins/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'vendor/**', 'apps/web/**'],
  },
})
