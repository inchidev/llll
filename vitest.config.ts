import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  define: {
    'import.meta.client': 'true',
  },
  resolve: {
    alias: {
      // Tests use deployment-core's source, so they need no build step first.
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
