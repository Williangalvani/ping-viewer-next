import { URL, fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.mjs, whose plugins generate files and need the whole app
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
