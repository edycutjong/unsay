/**
 * Tests for the three human-facing surfaces.
 *
 * Every case here asserts something that MUST FAIL if it breaks: a signature the
 * server would reject, an internal fact reaching Ray's screen, a proof link that
 * points at nothing, a headline number that has drifted from its receipt.
 */
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DEV_TOKEN_SECRET, DEV_WRITE_SECRET, signWriteBody } from '../src/http.ts'

const WEB = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(WEB, '..')
const PAGES = ['index.html', 'clinician.html', 'echo.html'] as const

const read = (name: string) => readFileSync(join(WEB, name), 'utf8')
const all = Object.fromEntries(PAGES.map((p) => [p, read(p)])) as Record<string, string>

/** Exactly what clinician.html signs: HMAC-SHA256 over `timestamp + "." + body`. */
const pageSignature = (secret: string, ts: string, body: string) =>
  createHmac('sha256', secret).update(ts + '.' + body).digest('hex')

const BODY = JSON.stringify({
  patient: 'ray',
  domain: 'weight_bearing',
  audience: 'user',
  value: 'Full weight-bearing as tolerated.',
  authorId: 'okafor',
  authorLabel: 'Sarah Okafor, physio',
  priority: 0.9,
})
const TS = '2026-10-08T09:14:22.418Z'
const SECRET = 'test-write-secret'

describe('the write screen signs what the server verifies', () => {
  it('produces the signature src/http.ts expects', () => {
    expect(pageSignature(SECRET, TS, BODY)).toBe(signWriteBody(SECRET, TS, Buffer.from(BODY, 'utf8')))
  })

  it('is rejected if the timestamp is left out of the MAC', () => {
    // The regression this guards: signing the body alone. It looks correct, posts
    // cleanly, and every write 401s with a message that names no cause.
    const bodyOnly = createHmac('sha256', SECRET).update(BODY).digest('hex')
    expect(bodyOnly).not.toBe(signWriteBody(SECRET, TS, Buffer.from(BODY, 'utf8')))
  })

  it('is rejected if one byte of the body changes after signing', () => {
    const tampered = BODY.replace('Full weight-bearing', 'Non-weight-bearing')
    expect(pageSignature(SECRET, TS, tampered)).not.toBe(
      signWriteBody(SECRET, TS, Buffer.from(BODY, 'utf8')),
    )
  })

  it('sends both headers the write path reads', () => {
    const http = readFileSync(join(REPO, 'src/http.ts'), 'utf8')
    for (const h of ['x-unsay-signature', 'x-unsay-timestamp']) {
      expect(http.toLowerCase()).toContain(`'${h}'`)
      expect(all['clinician.html']!.toLowerCase()).toContain(h)
    }
  })
})

describe("Ray's screen cannot show what Ray must not hear", () => {
  it('carries no care-internal:// URI', () => {
    expect(all['echo.html']).not.toContain('care-internal://')
  })

  it('carries no assistant-audience content from the seed', () => {
    // Verbatim fragments of the audience:["assistant"] records in src/seed.ts.
    for (const secret of ['Fall risk', 'disputes the discharge plan', 'over-reports', 'gait_note']) {
      expect(all['echo.html']).not.toContain(secret)
    }
  })

  it('filters the resource list to care:// regardless of the token presented', () => {
    expect(all['echo.html']).toContain("r.uri.startsWith('care://')")
  })
})

describe('no page can fake a live session', () => {
  it('has no mock, offline or dry-run switch in any page script', () => {
    // Scan the executable half only. The prose on the landing page NAMES these
    // tokens in order to promise they are absent, exactly as the DEMO.md gate in
    // scripts/check_submission_readiness.py does — a checker that fails on its own
    // disclaimer is checking the wrong thing.
    for (const [name, html] of Object.entries(all)) {
      const scripts = [...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1]!)
        .join('\n')
      expect(scripts.length, name).toBeGreaterThan(0)
      for (const token of ['MOCK=', 'OFFLINE=1', '--dry-run', 'FAKE=', 'SIMULATE=']) {
        expect(scripts, name).not.toContain(token)
      }
    }
  })

  it('labels the hero as an illustration rather than a recording', () => {
    expect(all['index.html']).toContain('Illustration of the mechanism')
    expect(all['index.html']).toContain('Not a recording of a live session')
  })

  it('labels the disconnected device screen and the unsent revision', () => {
    expect(all['echo.html']).toContain('SEED · NOT LIVE')
    expect(all['clinician.html']).toContain('Signed. Nothing was published.')
  })

  it('ships no credential of any kind', () => {
    for (const [name, html] of Object.entries(all)) {
      expect(html, name).not.toContain(DEV_WRITE_SECRET)
      expect(html, name).not.toContain(DEV_TOKEN_SECRET)
      expect(html, name).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/)
    }
  })
})

describe('the pages stand alone', () => {
  it('loads no script, stylesheet or font from anywhere', () => {
    for (const [name, html] of Object.entries(all)) {
      expect(html, name).not.toMatch(/<script[^>]+\ssrc=/i)
      expect(html, name).not.toMatch(/<link[^>]+stylesheet/i)
      expect(html, name).not.toMatch(/@import/i)
      expect(html, name).not.toMatch(/(?:href|src)="https?:/i)
    }
  })

  it('touches storage only through the guarded accessor', () => {
    for (const [name, html] of Object.entries(all)) {
      // window[a].getItem inside a try/catch is the only permitted form; a bare
      // localStorage.getItem() throws outright in some privacy modes.
      expect(html, name).not.toMatch(/\b(?:local|session)Storage\.\w+Item/)
    }
  })

  it('is theme-aware in both directions', () => {
    for (const [name, html] of Object.entries(all)) {
      expect(html, name).toContain('prefers-color-scheme: light')
      expect(html, name).toMatch(/<title>.+<\/title>/)
      expect(html, name).toContain('name="viewport"')
    }
  })
})

describe('every link on the landing page goes somewhere', () => {
  const targets = (html: string) =>
    [...html.matchAll(/(?:href|data-source|data-probe)="([^"#]+)"/g)]
      .map((m) => m[1]!)
      .filter((h) => !/^(?:https?:|mailto:|\/)/.test(h))

  for (const page of PAGES) {
    it(`${page} points at files that exist`, () => {
      const missing = targets(all[page]!).filter((t) => !existsSync(resolve(WEB, t)))
      expect(missing).toEqual([])
    })
  }
})

describe('the headline number matches its receipt', () => {
  const bench = JSON.parse(readFileSync(join(REPO, 'docs/proof/bench.json'), 'utf8'))
  const island = JSON.parse(
    /<script type="application\/json" id="bench"[^>]*>([\s\S]*?)<\/script>/.exec(all['index.html']!)![1]!,
  )

  const dig = (path: string) =>
    path.split('.').reduce<any>((o, k) => (o == null ? o : o[k]), bench)

  /**
   * `npm run bench` writes both the receipt and this page, rounding UP to one
   * decimal, so the invariant is exact rather than a tolerance: the page carries
   * the ceiling of the committed measurement and nothing else. Two things it
   * catches — a figure edited by hand to flatter the number, and a page left
   * behind by a re-measurement.
   *
   * An earlier version of this test allowed a 1.6x band. Run-to-run p95 on this
   * machine moves by more than that, so the band was measuring variance rather
   * than staleness and went red on an honest re-run.
   */
  const up1 = (x: number) => Math.ceil(x * 10) / 10

  it('never quotes a number better than the receipt', () => {
    for (const path of ['endToEnd.p50', 'endToEnd.p95', 'writeToNotification.p50']) {
      const actual = dig(path) as number
      const shown = path.split('.').reduce<any>((o, k) => o[k], island) as number
      expect(shown, `${path} understates the receipt`).toBeGreaterThanOrEqual(actual)
      expect(shown, `${path} was not generated from the receipt`).toBe(up1(actual))
    }
  })

  it('quotes the committed run count and mid-sentence tally', () => {
    expect(island.n).toBe(bench.n)
    expect(island.midSentence).toBe(bench.midSentence.count)
    expect(bench.midSentence.of).toBe(bench.n)
  })

  it('renders the same figures in the markup as in the island', () => {
    const shown = Object.fromEntries(
      [...all['index.html']!.matchAll(/data-bench="([^"]+)">([^<]+)</g)].map((m) => [m[1]!, m[2]!]),
    )
    expect(shown['endToEnd.p50']).toBe(island.endToEnd.p50.toFixed(1))
    expect(shown['endToEnd.p95']).toBe(island.endToEnd.p95.toFixed(1))
    expect(shown['midSentence']).toBe(String(island.midSentence))
    expect(shown['n']).toBe(String(island.n))
  })

  it('keeps the loopback caveat attached to the number', () => {
    expect(all['index.html']).toContain('not a production figure')
  })
})
