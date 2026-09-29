import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    benchmark: {
      include: ['benchmarks/**/*.bench.ts'],
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary'],
      // Floors a few points below the measured level: a ratchet that catches
      // coverage backsliding without failing on minor per-PR dips. Raise
      // deliberately as coverage improves.
      thresholds: {
        statements: 90,
        branches: 84,
        functions: 95,
        lines: 91,
      },
    },
  },
})
