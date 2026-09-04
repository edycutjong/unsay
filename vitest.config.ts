import { defineConfig } from 'vitest/config'

/**
 * `web/**` is in here on purpose: the three pages carry the signing code the
 * server verifies and the bench figures the landing page quotes, and a suite that
 * cannot see them is a suite that cannot catch either drifting.
 *
 * `packages/**` is the extracted @unsay/live-resources package. Its suite imports
 * that package's public entry point and nothing from src/, so it stays a standalone
 * proof — running it here only means the gate that guards this repo also guards the
 * half of it someone else could depend on.
 */
export default defineConfig({
  test: { include: ['test/**/*.test.ts', 'web/**/*.test.ts', 'packages/**/test/**/*.test.ts'] },
})
