import { URL, fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.mjs, whose plugins generate files and need the whole app
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: './src/test/nodeClientEnvironment.ts',
    include: ['src/**/*.test.ts'],
  },
});
