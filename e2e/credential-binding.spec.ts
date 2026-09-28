import { expect, test } from '@playwright/test'

/**
 * A demo link's bearer token must never reach a server other than the one that
 * minted it. CodeQL's js/client-side-request-forgery pointed at the pages' fetch
 * calls; the real defect was one step upstream. `?base=` was persisted to
 * localStorage, and a link carrying only `?token=` fell back to that stored base —
 * so one earlier visit to `echo.html?base=https://attacker.invalid` planted an
 * origin, and the next click on the landing page's Echo Show link sent the token
 * there. Both halves are reproduced here, in the order an attacker would need.
 */
const ATTACKER = 'https://attacker.invalid'

for (const page of ['echo.html', 'clinician.html']) {
  test(`${page}: a planted base never receives a token`, async ({ context, baseURL }) => {
    const leaked: string[] = []
    await context.route(`${ATTACKER}/**`, (route) => {
      leaked.push(`${route.request().method()} ${route.request().url()} auth=${route.request().headers()['authorization'] ?? '-'}`)
      return route.abort()
    })

    // 1 · the plant: a credential-free link that only sets the base.
    const tab = await context.newPage()
    await tab.goto(`/${page}?base=${encodeURIComponent(ATTACKER)}`)
    await tab.waitForTimeout(300)
    // With no credentials, nothing it sends can carry one.
    expect(leaked.filter((l) => !l.endsWith('auth=-'))).toEqual([])

    // 2 · the victim's next, legitimate click: the landing page's own link.
    const landing = await context.newPage()
    await landing.goto('/')
    const name = page === 'echo.html' ? /The Echo Show screen/ : /The clinician write screen/
    const href = await landing.getByRole('link', { name }).first().getAttribute('href')
    const screen = await context.newPage()
    await screen.goto('/' + href)
    await expect(screen.locator('#base')).toHaveValue(new URL(baseURL!).origin)

    // 3 · same tab, credentials now stored, a second planted base: not reused.
    await screen.goto(`/${page}?base=${encodeURIComponent(ATTACKER)}`)
    await expect(screen.locator('#token')).toHaveValue('')
    await screen.waitForTimeout(300)

    expect(leaked.filter((l) => !l.endsWith('auth=-'))).toEqual([])
  })
}
