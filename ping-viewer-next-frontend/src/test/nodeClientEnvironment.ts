import type { Environment } from 'vitest';

// Plain node globals, but modules go through Vite's client transforms so .vue files compile
// to client render functions (mountable with a custom renderer) instead of SSR ones.
export default {
  name: 'node-client',
  viteEnvironment: 'client',
  setup: () => ({ teardown: () => {} }),
} satisfies Environment;
