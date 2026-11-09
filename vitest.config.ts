import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['plugins/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'vendor/**', 'apps/web/**'],
  },
})
