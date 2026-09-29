import { expect, test } from '@playwright/test'

/**
 * The product, in two tabs. The physio publishes a revision on the clinician
 * screen; Ray's Echo Show strikes the line it was showing and replaces it. No
 * stub between them: a real signed POST /write, a real notifications/resources/
 * updated over SSE, and a real authorized re-read by the page's own MCP client.
 */
test('a published revision strikes through on the Echo Show', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL! })
  const landing = await context.newPage()
  await landing.goto('/')

  // The landing page mints the tokens; take its links exactly as a visitor would.
  const echoHref = await landing.getByRole('link', { name: /The Echo Show screen/ }).first().getAttribute('href')
  const clinHref = await landing.getByRole('link', { name: /The clinician write screen/ }).first().getAttribute('href')
  expect(echoHref).toMatch(/^echo\.html\?/)
  expect(clinHref).toMatch(/^clinician\.html\?/)

  const echo = await context.newPage()
  await echo.goto('/' + echoHref)
  // LIVE, not merely "not connecting": before the first read the screen shows the
  // committed seed, and both device projects share one server — so after the
  // desktop run the seed text is no longer the current value (flaked on CI).
  await expect(echo.locator('#sStatusText')).toContainText('LIVE', { timeout: 15_000 })
  const before = (await echo.locator('#sFact').textContent())!.trim()
  expect(before).not.toBe('—')

  const clin = await context.newPage()
  await clin.goto('/' + clinHref)
  // The screen paints the seed plan while it connects, then swaps in the live one.
  // A click during the swap lands on a card that is about to be replaced — it
  // flaked exactly that way on a CI runner — so wait for live, as a person would.
  await expect(clin.locator('#statusText')).toContainText('live', { timeout: 15_000 })
  // By field, not by text: the text is whatever the previous run left there.
  const card = clin.locator('li').filter({ hasText: /weight[ _-]?bearing/i }).filter({ hasText: before }).first()
  await card.getByRole('button').first().click()

  const revised = `Walk with two crutches, partial weight only, until review (${Date.now()})`
  await clin.getByRole('textbox', { name: /Revised value for weight bearing/ }).fill(revised)
  await clin.getByRole('button', { name: 'Publish revision' }).click()

  await expect(echo.locator('#sOld')).toHaveClass(/struck/, { timeout: 10_000 })
  await expect(echo.locator('#sOld')).toContainText(before.split(' ')[0]!)
  await expect(echo.locator('#sFact')).toHaveText(revised)
  await context.close()
})
