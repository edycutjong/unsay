import { expect, test } from '@playwright/test'

/**
 * No page scrolls sideways at a phone, a tablet or a laptop width. The Echo Show
 * is a fixed 1280×800 device and is allowed to scale, not to overflow.
 */
const WIDTHS = [375, 768, 1440]
const PAGES = ['/', '/judge', '/clinician.html', '/echo.html', '/doc/readme']

// The width is set explicitly, so the device profile adds nothing but a second run.
test.skip(({ isMobile }) => isMobile, 'widths are set explicitly; one project is enough')

for (const width of WIDTHS) {
  for (const path of PAGES) {
    test(`${path} has no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(1)
    })
  }
}
