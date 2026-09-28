import { expect, test } from '@playwright/test'

/**
 * /judge is the URL in the submission. It must answer a browser that has never
 * been here: no token, no cookie, no redirect, and the claim before anything else.
 */
test('/judge answers a cold browser with the claim and a working path', async ({ page, context }) => {
  await context.clearCookies()
  const res = await page.goto('/judge')
  expect(res?.status()).toBe(200)
  expect(res?.request().redirectedFrom()).toBeNull()
  await expect(page.locator('h1')).toContainText('For judges')
  await expect(page.locator('main')).toContainText('An MCP server whose resources can be revised mid-sentence')
  await expect(page.getByRole('link', { name: 'Judges' })).toHaveAttribute('aria-current', 'page')
  expect(await context.cookies()).toEqual([])
})
