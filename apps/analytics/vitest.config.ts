import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { setupFiles: ['test/setup.ts'] },
});
