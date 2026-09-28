import { expect, test } from '@playwright/test'

/**
 * Every public page, opened cold: 200, no console error, and no request to any
 * origin but this one. The three surfaces promise to load nothing from anywhere,
 * and web/web.test.ts checks the source for it — this checks what a browser did.
 *
 * The rendered README is the one exception, and a narrow one: its badge rows are
 * shields.io images and the CI badge, as on GitHub. Nothing else foreign is allowed.
 */
const PAGES = ['/', '/judge', '/echo.html', '/clinician.html', '/doc/readme', '/doc/demo', '/verify']
const ALLOWED: Record<string, string[]> = { '/doc/readme': ['https://img.shields.io', 'https://github.com'] }

for (const path of PAGES) {
  test(`${path} loads with no console error and no third-party request`, async ({ page, baseURL }) => {
    const errors: string[] = []
    const foreign: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (!u.protocol.startsWith('http') || u.origin === new URL(baseURL!).origin) return
      if (!(ALLOWED[path] ?? []).includes(u.origin)) foreign.push(r.url())
    })
    const res = await page.goto(path)
    expect(res?.status()).toBe(200)
    await page.waitForLoadState('networkidle')
    expect(errors).toEqual([])
    expect(foreign).toEqual([])
  })
}

test('the landing page carries its title and card metadata', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('h1')).toHaveText('The assistant that can be corrected.')
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(1)
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', /summary/)
})
