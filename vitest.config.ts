import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    allowOnly: true,
    passWithNoTests: true,
    globals: true,
    watch: false,
    maxWorkers: '50%',
  },
});
