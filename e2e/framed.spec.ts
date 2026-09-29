import { expect, test } from '@playwright/test'

/**
 * a2a r02. A host that renders the MCP Apps card frames it with no token and no bridge
 * yet (F-013). The seeded plan would then sit beside a whats_changed result that says
 * it changed — so, framed without a token, the card shows no clinical instruction.
 */
test('framed without a token, the Echo Show card shows no seeded instruction', async ({ page, baseURL }) => {
  await page.setContent(`<iframe id="card" src="${baseURL}/echo.html" width="1280" height="800"></iframe>`)
  const card = page.frameLocator('#card')
  await expect(card.locator('#sFact')).toContainText('Not live inside a host yet')
  await expect(card.locator('body')).not.toContainText(/weight[- ]bearing/i)
})

test('opened directly without a token, the card still shows the labelled seed record', async ({ page }) => {
  await page.goto('/echo.html')
  await expect(page.locator('#sFact')).not.toContainText('Not live inside a host yet')
})
