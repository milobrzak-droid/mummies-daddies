import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    // Studený import těžkých stránek při plné sadě (paralelně, ~200 souborů)
    // občas přesáhl výchozích 5 s; test pak padal jen pod zátěží.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: true,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '.claude/**'],
  },
  resolve: {
    // fileURLToPath (not `.pathname`) correctly decodes paths with spaces/special chars.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
})
