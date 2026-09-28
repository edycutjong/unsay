import { defineConfig, devices } from '@playwright/test'

/**
 * The browser half of the end-to-end story. `npm run e2e` drives the protocol —
 * MCP frames over Streamable HTTP, the way a host would. This drives the pages the
 * way a person would: a real Chromium, a real `npm start`, two tabs side by side.
 *
 * A port of its own, so it never reuses a dev server someone left running with
 * different secrets and a different seed.
 */
const PORT = 39_561

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node --experimental-strip-types scripts/serve.ts',
    url: `http://127.0.0.1:${PORT}/health`,
    env: { PORT: String(PORT), HOST: '127.0.0.1' },
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
