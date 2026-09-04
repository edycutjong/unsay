import { defineConfig } from 'vitest/config'

/**
 * `web/**` is in here on purpose: the three pages carry the signing code the
 * server verifies and the bench figures the landing page quotes, and a suite that
 * cannot see them is a suite that cannot catch either drifting.
 */
export default defineConfig({
  test: { include: ['test/**/*.test.ts', 'web/**/*.test.ts'] },
})
