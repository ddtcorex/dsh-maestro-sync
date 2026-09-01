import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // jsdom per-file via the // @vitest-environment jsdom pragma in client specs
  },
});