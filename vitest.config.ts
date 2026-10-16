import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  define: {
    'import.meta.client': 'true',
  },
  resolve: {
    alias: {
      // Tests use admin-core's source, so they need no build step first.
      '@llll/deployment-core': fileURLToPath(new URL('./packages/deployment-core/src/index.ts', import.meta.url)),
      '~~': fileURLToPath(new URL('.', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
})
