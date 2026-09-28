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

  it('checks in no credential of any kind — the files on disk', () => {
    /**
     * Named for what it reads. It was called "ships no credential of any kind",
     * which is a claim about the bytes a browser receives, and those are not these
     * bytes: `src/http.ts` dresses index.html with a minted token and, while the
     * dev key is in use, with DEV_WRITE_SECRET on the clinician link. The test
     * passed the whole time and overstated its own scope — the R10 shape this repo
     * polices everywhere else. The case below reads what a browser actually gets.
     */
    for (const [name, html] of Object.entries(all)) {
      expect(html, name).not.toContain(DEV_WRITE_SECRET)
      expect(html, name).not.toContain(DEV_TOKEN_SECRET)
      expect(html, name).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/)
    }
  })

  it('serves only the two credentials the landing page says it hands out', async () => {
    const { createHttpServer } = await import('../src/http.ts')
    const srv = await createHttpServer({ announce: false })
    try {
      const body = await (await fetch(`${srv.baseUrl}/index.html`)).text()
      // The demo read token, on every link into the two live screens…
      const bare = (all['index.html']!.match(/href="(?:echo|clinician)\.html"/g) ?? []).length
      expect(bare, 'the landing page links into neither live screen').toBeGreaterThan(1)
      expect((body.match(/href="(?:echo|clinician)\.html\?token=/g) ?? []).length).toBe(bare)
      // …and the dev write key, on the clinician link only, because it is the key
      // this repository publishes and it protects nothing. The landing note has to
      // say so: a judge is about to click through with it in the URL bar.
      expect(body).toContain(`key=${encodeURIComponent(DEV_WRITE_SECRET)}`)
      expect(all['index.html'], 'the jump note no longer discloses the write key')
        .toContain('write key in its query string')
      // The signing secrets themselves never leave the process.
      expect(body).not.toContain(DEV_TOKEN_SECRET)
    } finally {
      await srv.close()
    }
  })

  it('serves no write key at all once a real one is configured', async () => {
    const { createHttpServer } = await import('../src/http.ts')
    const srv = await createHttpServer({ announce: false, writeSecret: 'a-real-deployment-secret' })
    try {
      const body = await (await fetch(`${srv.baseUrl}/index.html`)).text()
      expect(body).toContain('href="echo.html?token=')
      expect(body, 'a configured write secret reached the page').not.toContain('a-real-deployment-secret')
      expect(body).not.toContain('key=')
    } finally {
      await srv.close()
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

describe("Ray's screen carries the disclaimer the other two carry", () => {
  const DISCLAIMER =
    'Unsay relays what a clinician wrote. It does not generate clinical guidance and is not a'

  it('states it on every human-facing page, not only the landing one', () => {
    for (const page of PAGES) {
      expect(all[page], page).toContain(DISCLAIMER)
    }
  })

  it('keeps it visible in presentation mode, which is what the video films', () => {
    // `body.present` hides the whole shell. A disclaimer only in the shell is a
    // disclaimer that is absent from the artifact a judge actually sees.
    expect(all['echo.html']).toContain('body.present .present-note')
    expect(all['echo.html']).toMatch(/present-note[^>]*>Unsay relays what a clinician wrote/)
  })

  it('emits no clinical instruction that no clinician wrote', () => {
    /**
     * The page used to render "Check with the ward before your next dose." at 28px
     * — an unsourced instruction about medication, on the most patient-facing
     * surface in the product. Anything this page says about acting must be about
     * the RECORD, and must be labelled as the system speaking.
     */
    const scripts = all['echo.html']!
    for (const clinical of ['your next dose', 'take your', 'stop taking', 'increase the', 'reduce the']) {
      expect(scripts.toLowerCase(), clinical).not.toContain(clinical)
    }
    expect(scripts).toContain('past its review date')
    expect(scripts).toContain("'src', 'unsay'") // the system marker on that line
  })
})

describe('the page counts match what they are counting', () => {
  /**
   * Three prose counts on the landing page were day-2 stale and every one of them
   * UNDERSOLD the build by roughly 3x — eleven assertions for twenty-nine, four
   * friction entries for twelve. The bench figures were gated and correct; these
   * were gated by nothing. They are now a small island of `data-count` spans, and
   * this recomputes each of them from the artifact it describes.
   */
  const counts = Object.fromEntries(
    [...all['index.html']!.matchAll(/data-count="([^"]+)">([^<]+)</g)].map((m) => [m[1]!, Number(m[2]!)]),
  )
  const friction = readFileSync(join(REPO, 'FRICTION.md'), 'utf8')
  const verifyReceipt = JSON.parse(readFileSync(join(REPO, 'docs/proof/verify.json'), 'utf8'))

  it('names every count the page renders', () => {
    expect(Object.keys(counts).sort()).toEqual(['friction', 'frictionSpec', 'verify'])
  })

  it('quotes the number of friction entries there actually are', () => {
    const entries = friction.match(/^## F-0\d+/gm) ?? []
    expect(counts.friction).toBe(entries.length)
  })

  it('quotes the number of spec-side entries the friction log itself claims', () => {
    // The log's own summary paragraph names them; the page must agree with it.
    const ids = /\*\*Seven\*\* ask for a change to the MCP specification[^—]*—\s*([^.]+)\./.exec(friction)
    expect(ids, 'the friction summary no longer names its spec entries').not.toBeNull()
    expect(ids![1]!.split(',').length).toBe(counts.frictionSpec)
  })

  it('quotes the number of assertions npm run verify actually made', () => {
    // Against the receipt the script writes, not against a grep of its source — a
    // loop makes more assertions than it has call sites, and the page quotes the
    // number a judge sees printed.
    expect(counts.verify).toBe(verifyReceipt.assertions)
    expect(verifyReceipt.verdict).toBe('PASS')
    // The split the README quotes comes out of the same receipt.
    expect(verifyReceipt.inProcess + verifyReceipt.overHttp).toBe(verifyReceipt.assertions)
  })
})

describe('every pointer the pages give a judge lands on something', () => {
  it('names a symbol that is greppable in the file it links to', () => {
    /**
     * DEMO.md's "what a judge should look at first" and this page both sent the
     * reader to `src/store.ts read()` — the second thing the docs ask a judge to
     * do — after `read()` had moved into the package. Asserting the file exists is
     * not enough: the file existed the whole time.
     */
    const demo = readFileSync(join(REPO, 'DEMO.md'), 'utf8')
    const pairs: [string, string][] = [
      ['packages/live-resources/src/store.ts', 'read('],
      ['src/retraction.ts', 'renderRetraction'],
    ]
    for (const [file, symbol] of pairs) {
      expect(readFileSync(join(REPO, file), 'utf8'), `${file} › ${symbol}`).toContain(symbol)
    }
    // The two highest-traffic pointers in the repo: the landing page's enforcement
    // link, and item 2 of DEMO.md's "what a judge should look at first".
    expect(all['index.html']).toContain('/packages/live-resources/src/store.ts')
    expect(demo).toContain('`packages/live-resources/src/store.ts` `read()`')
    expect(demo).not.toMatch(/`src\/store\.ts` `read\(\)`/)
  })

  it('links nothing at a relative path that would 404 under npm start', () => {
    // Every off-page link is now root-relative and answered by the REPO_FILES
    // allowlist in src/http.ts. A `../` link resolves to nothing on a server.
    const http = readFileSync(join(REPO, 'src/http.ts'), 'utf8')
    const served = new Set([...http.matchAll(/'(\/[\w./-]+)': '[\w./-]+',/g)].map((m) => m[1]!))
    served.add('/verify')
    // The five prose documents are rendered at /doc/<name> rather than served as
    // markdown source; the routes come from the same table the server routes on.
    const docs = readFileSync(join(REPO, 'src/docpage.ts'), 'utf8')
    const docRoutes = [...docs.matchAll(/'(\/doc\/\w+)': \{ file:/g)].map((m) => m[1]!)
    expect(docRoutes.length, 'DOC_PAGES no longer parses').toBe(5)
    for (const r of docRoutes) served.add(r)
    const rooted = [...all['index.html']!.matchAll(/(?:href|data-source|data-probe)="(\/[^"#]*)"/g)]
      .map((m) => m[1]!)
    expect(rooted.length).toBeGreaterThan(6)
    expect(rooted.filter((p) => !served.has(p))).toEqual([])
    expect(all['index.html']).not.toContain('href="../')
  })
})

describe('the retraction on the page is the one the server renders', () => {
  it('matches renderRetraction() for the seeded revision, word for word', async () => {
    /**
     * The sentence the product is named for used to exist as three different
     * literals — here, in DEMO.md and in scripts/e2e.ts — generated by nothing.
     * `file://` cannot import a sibling module, so the page still carries a copy;
     * this recomputes it from src/retraction.ts and fails if the two ever differ.
     */
    const { renderRetraction } = await import('../src/retraction.ts')
    const { DEMO_NOW, RAY, STAGED_REVISION, seedDemo } = await import('../src/seed.ts')
    const store = seedDemo()
    store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    const chain = store.versions(RAY, 'weight_bearing')
    const expected = renderRetraction(chain.at(-2)!, chain.at(-1)!, {
      now: new Date(DEMO_NOW.getTime() + 30_000),
    })
    const onPage = /const A2 = '([^']*)'/.exec(all['index.html']!)?.[1]
    expect(onPage, 'the hero no longer defines A2').toBeTypeOf('string')
    expect(onPage).toBe(expected)
  })
})

describe('the clinician screen renders a care plan, and nothing else', () => {
  /**
   * The page walked `resources/list` with no URI filter, so `ui://unsay/echo` — the
   * MCP Apps card — was read, parsed as an editable clinical instruction and
   * rendered inside Ray Dunn's care plan: a 12,086-pixel card titled "ECHO" holding
   * the entire Echo Show HTML source, with a "change" button on it. Publishing that
   * card minted a `care://unsay/echo` chain, and the store is append-only, so one
   * click broke the `ALL 5 CHAIN(S) INTACT` line DEMO.md tells a judge to expect for
   * the life of that process. echo.html has had the guard since day 6.
   *
   * The rule below is sliced out of the page between the LIST-SHAPE markers and run
   * here against a live server, so this test and the browser cannot disagree.
   */
  const shape = /\/\* LIST-SHAPE:begin[\s\S]*?\*\/([\s\S]*?)\/\* LIST-SHAPE:end \*\//
    .exec(all['clinician.html']!)?.[1]

  const rules = () => {
    expect(shape, 'clinician.html no longer marks its list shape').toBeTypeOf('string')
    return new Function(`${shape}\nreturn { isCareUri, byClinicalPriority }`)() as {
      isCareUri: (uri: string) => boolean
      byClinicalPriority: (a: { priority: number; uri: string }, b: { priority: number; uri: string }) => number
    }
  }

  it('drops every resource outside the care schemes, live', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    )
    const { createHttpServer, mintToken } = await import('../src/http.ts')
    const { isCareUri } = rules()

    const srv = await createHttpServer({ announce: false })
    try {
      const client = new Client({ name: 'clinician-shape', version: '0.1.0' }, { capabilities: {} })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${srv.baseUrl}/mcp`), {
          requestInit: {
            headers: {
              Authorization: `Bearer ${mintToken({
                sub: 'clinician',
                scopes: ['care.read.user'],
                audience: srv.resourceUrl,
              })}`,
            },
          },
        }),
      )
      const listed: { uri: string; annotations?: { priority?: number } }[] = []
      let cursor: string | undefined
      do {
        const page = await client.listResources(cursor ? { cursor } : {})
        listed.push(...page.resources)
        cursor = page.nextCursor
      } while (cursor)

      // If the seed ever stops carrying the card, this test proves nothing.
      expect(listed.map((r) => r.uri), 'the default seed no longer lists the ui:// card')
        .toContain('ui://unsay/echo')

      const rendered = listed.filter((r) => isCareUri(r.uri))
      expect(rendered.filter((r) => !r.uri.startsWith('care'))).toEqual([])
      expect(rendered.length).toBe(listed.length - 1)
      await client.close()
    } finally {
      await srv.close()
    }
  })

  it('leads with the record under discussion, live and on seed alike', () => {
    /**
     * The server annotates every record with a clinical priority, the page parses
     * it and echoes it back on every write — and never ordered by it, so the live
     * screen led with "anticoagulant" in alphabetical URI order while the seed
     * screen led with the weight-bearing instruction the hero, the echo card and
     * the README lede are all built around. Same screen, two different first rows.
     */
    const { byClinicalPriority } = rules()
    const seed = [...all['clinician.html']!.matchAll(/\{ uri:'([^']+)'[\s\S]*?priority:([\d.]+)/g)]
      .map((m) => ({ uri: m[1]!, priority: Number(m[2]!) }))
    expect(seed.length, 'the page no longer carries a seed list').toBeGreaterThan(3)
    expect(seed.slice().sort(byClinicalPriority)[0]!.uri).toBe('care://ray/weight_bearing')
  })

  it('says how many of the listed resources it rendered, rather than only how many exist', () => {
    // The status chip read "live · 6 resources" over five cards. Both numbers, so
    // the filtering is visible instead of silent.
    expect(all['clinician.html']).toContain("' of ' + listed.length + ' resources'")
    expect(all['clinician.html']).toContain("' of ' + state.listed + ' resources over MCP")
  })
})

describe('the pinned seed on the pages is the seed in src/seed.ts', () => {
  /**
   * Both pages carry a copy of the seed record, shown when no server answers and
   * labelled as such. The anticoagulant sentence names a stop date, and that date
   * was pinned in three places while `staleAfter` was made relative to the injected
   * clock — so the live server flagged a record as past its review date whose own
   * words named a stop date a month in the future. The sentence is derived from the
   * clock now; this fails if a page's copy stops matching what the seed publishes.
   */
  it('quotes the anticoagulant value the seed publishes on its pinned clock', async () => {
    const { RAY, seedDemo } = await import('../src/seed.ts')
    const value = seedDemo().versions(RAY, 'anticoagulant').at(-1)!.value
    expect(value).toMatch(/Stop date: \d+ \w+ \d{4}\./)
    for (const page of ['clinician.html', 'echo.html'] as const) {
      expect(all[page], `${page}'s seed record has drifted from src/seed.ts`).toContain(value)
    }
  })

  it('pins those pages to the clock the seed was built on', async () => {
    const { DEMO_NOW } = await import('../src/seed.ts')
    for (const page of ['clinician.html', 'echo.html'] as const) {
      expect(all[page], page).toContain(`SEED_NOW = '${DEMO_NOW.toISOString().replace('.000', '')}'`)
    }
  })
})

describe('an expired link is reported as an expired link', () => {
  /**
   * Both screens turned a 401 with `error_description: "expired"` into "not
   * connected to an Unsay server" — blaming a component that is up, and naming no
   * recovery. With the landing page's own links expiring after an hour, it was the
   * likeliest failure a judge would ever see here. The page's own client is sliced
   * and run against a live server holding a token that has already run out.
   */
  const core = /\/\* MCP-CLIENT-CORE:begin[\s\S]*?\*\/([\s\S]*?)\/\* MCP-CLIENT-CORE:end \*\//
    .exec(all['echo.html']!)?.[1]

  it('says the token expired, and what to do about it', async () => {
    const { createHttpServer, mintToken } = await import('../src/http.ts')
    const srv = await createHttpServer({ announce: false })
    try {
      const dead = mintToken({
        sub: 'echo-show',
        scopes: ['care.read.user'],
        audience: srv.resourceUrl,
        ttlSeconds: -60,
      })
      const build = new Function('base', 'token', 'PROTOCOL', `${core}\nreturn { rpc }`)
      const page = build(() => srv.baseUrl, () => dead, '2025-11-25')
      await expect(page.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} }))
        .rejects.toThrow(/token in this link has expired/)
      // …and the label the page paints for it is not "not connected".
      expect(all['echo.html']).toContain("expiredLink ? 'token expired' : 'not connected'")
      expect(all['clinician.html']).toContain('This link’s token has expired.')
    } finally {
      await srv.close()
    }
  })
})

describe('the hero explains itself with motion turned off', () => {
  /**
   * Under `prefers-reduced-motion: reduce` the stage rendered the label "RAY" above
   * an EMPTY line: `final()` set the element's opacity and never its text, which
   * only `run()` did — so a reduced-motion reader saw an assistant contradict
   * itself with no question on screen to contradict, plus a labelled blank row that
   * reads as a rendering bug. That path is taken on load and on every Replay click.
   *
   * The two functions are executed here, as the page defines them, against stubs of
   * the four things they touch.
   */
  const slice = (name: string) =>
    new RegExp(`\n  function ${name}\\(\\) \\{[\\s\\S]*?\n  \\}`).exec(all['index.html']!)?.[0]

  const RAY_Q = /const RAY_Q = '([^']*)'/.exec(all['index.html']!)?.[1]

  it('writes the question in the reduced-motion end state, not only in the animation', () => {
    expect(RAY_Q, 'the hero no longer defines RAY_Q').toBeTypeOf('string')
    const reset = slice('reset')
    const final = slice('final')
    expect(reset, 'the hero no longer defines reset()').toBeTypeOf('string')
    expect(final, 'the hero no longer defines final()').toBeTypeOf('string')

    const stub = () => ({
      textContent: '',
      style: {} as Record<string, string>,
      classList: { add() {}, remove() {} },
    })
    const rayLine = stub()
    const run = new Function(
      'clear', 'rayLine', 'uttA', 'wa', 'wb', 'frameEls', 'RAY_Q',
      `${reset}
${final}
final()`,
    )
    run(() => {}, rayLine, stub(), [], [], [], RAY_Q)
    expect(rayLine.textContent, 'the reduced-motion stage renders "RAY" above an empty line')
      .toBe(RAY_Q)
    expect(rayLine.style.opacity).toBe('1')
  })
})

describe("the device screen's own MCP client, executed", () => {
  /**
   * echo.html hand-rolls a second MCP-over-Streamable-HTTP client — initialize, the
   * session headers, the SSE framer, `Last-Event-ID` — because a single-file page
   * cannot import the SDK. `npm run e2e` drives the SDK's transport, so this one,
   * the one the demo video films and a judge screenshots, was the only transport in
   * the repo that nothing ran. FRICTION F-011 (the empty `data:` frame the framer
   * had to learn about) is evidence the seam is genuinely fragile.
   *
   * The code below is not a copy. It is sliced verbatim out of the page between the
   * MCP-CLIENT-CORE markers and executed here against a live server, so a drift
   * between this test and the browser is not possible.
   */
  const core = /\/\* MCP-CLIENT-CORE:begin[\s\S]*?\*\/([\s\S]*?)\/\* MCP-CLIENT-CORE:end \*\//
    .exec(all['echo.html']!)?.[1]

  it('is present in the page, between the markers the test slices on', () => {
    expect(core, 'echo.html no longer marks its client core').toBeTypeOf('string')
    for (const symbol of ['function drain', 'async function rpc', 'function mcpHeaders']) {
      expect(core, symbol).toContain(symbol)
    }
  })

  it('holds a session, subscribes, and receives the correction over its own SSE reader', async () => {
    const { createHttpServer, mintToken, signWriteBody } = await import('../src/http.ts')
    const { LiveResourceStore, uriFor } = await import('../src/store.ts')
    const { RAY, STAGED_REVISION, seedDemo } = await import('../src/seed.ts')

    const srv = await createHttpServer({
      store: seedDemo(new LiveResourceStore()),
      tokenSecret: 'echo-page-token-secret',
      writeSecret: 'echo-page-write-secret',
      announce: false,
    })
    try {
      const bearer = mintToken({
        sub: 'echo-show',
        scopes: ['care.read.user'],
        audience: srv.resourceUrl,
        secret: 'echo-page-token-secret',
      })
      // The page's own code, given only what it closes over.
      const build = new Function(
        'base',
        'token',
        'PROTOCOL',
        `${core}\nreturn { mcp, mcpHeaders, drain, firstMessage, rpc, notify }`,
      )
      const page = build(() => srv.baseUrl, () => bearer, '2025-11-25')

      const init = await page.rpc('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'unsay-echo-web', version: '0.1.0' },
      })
      expect(init.protocolVersion).toBe('2025-11-25')
      expect(page.mcp.sid, 'the page never captured Mcp-Session-Id').toBeTypeOf('string')
      await page.notify('notifications/initialized')

      const WB = uriFor(RAY, 'weight_bearing', 'user')
      // The page walks the cursor, because the list is paginated at three and the
      // fact it renders is not on page one.
      const walked: string[] = []
      let cursor: string | undefined = undefined
      let pages = 0
      do {
        const listed: { resources: { uri: string }[]; nextCursor?: string } =
          await page.rpc('resources/list', cursor ? { cursor } : {})
        walked.push(...listed.resources.map((r) => r.uri))
        cursor = listed.nextCursor
        pages++
      } while (cursor)
      expect(pages).toBeGreaterThan(1)
      expect(walked).toContain(WB)
      // Ray's token: the partition holds for the page as it does for the SDK client.
      expect(walked.some((u) => u.startsWith('care-internal://'))).toBe(false)

      await page.rpc('resources/subscribe', { uri: WB })

      // The standalone SSE stream, read by the page's own framer.
      const headers = page.mcpHeaders({ Accept: 'text/event-stream' })
      delete headers['Content-Type']
      const stream = await fetch(`${srv.baseUrl}/mcp`, { method: 'GET', headers })
      expect(stream.ok).toBe(true)
      const reader = stream.body!.getReader()
      const dec = new TextDecoder()

      const seen: { method?: string; params?: { uri?: string } }[] = []
      let lastEventId: string | null = null
      const pump = (async () => {
        let buf = ''
        const deadline = Date.now() + 5000
        while (Date.now() < deadline && !seen.some((m) => m.method === 'notifications/resources/updated')) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n')
          buf = page.drain(buf, (msg: unknown, eventId: string | null) => {
            if (eventId) lastEventId = eventId
            if (msg) seen.push(msg as { method?: string })
          })
        }
      })()

      await new Promise((r) => setTimeout(r, 120))

      // The physio writes, through the signed path, exactly as clinician.html does.
      const raw = Buffer.from(
        JSON.stringify({
          patient: RAY,
          domain: STAGED_REVISION.topic,
          audience: STAGED_REVISION.audience,
          value: STAGED_REVISION.value,
          authorId: STAGED_REVISION.authorId,
          authorLabel: STAGED_REVISION.authorLabel,
        }),
        'utf8',
      )
      const ts = new Date().toISOString()
      const wrote = await fetch(`${srv.baseUrl}/write`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-unsay-timestamp': ts,
          'x-unsay-signature': signWriteBody('echo-page-write-secret', ts, raw),
        },
        body: raw,
      })
      expect(wrote.status).toBe(200)
      expect((await wrote.json()).subscribers, 'the page was not counted as a subscriber').toBe(1)

      await pump
      await reader.cancel().catch(() => {})

      const updated = seen.find((m) => m.method === 'notifications/resources/updated')
      expect(updated, 'the page never saw notifications/resources/updated').toBeTruthy()
      expect(updated!.params!.uri).toBe(WB)
      // The event id is what a resume would replay from — the page records it.
      expect(lastEventId, 'no SSE event id reached the page').toBeTypeOf('string')

      // …and the re-read the page does next returns the corrected value.
      const after = await page.rpc('resources/read', { uri: WB })
      const text = after.contents.find((c: { text?: string }) => typeof c.text === 'string').text
      expect(text).toContain(STAGED_REVISION.value)
      expect(text.split('\n')[0]).toMatch(/^\[changed /)
    } finally {
      await srv.close()
    }
  }, 20_000)
})

describe('the proof card describes the payload the endpoint returns', () => {
  /**
   * The card headed "The judge's instrument" told a judge that `GET /verify`
   * returns the negotiated `initialize` block and live
   * `notifications/resources/updated` frames. It returns neither and never has —
   * the negotiated block is in `docs/proof/probe_subscribe.json` and the frames go
   * down `/mcp`. Every other count on that page is recomputed from its artifact;
   * this prose was gated by nothing, which is R6 in its exact canonical form on the
   * page a judge is most likely to open first, one `curl` away from being caught.
   */
  it('names only keys a live GET /verify actually carries', async () => {
    const { createHttpServer } = await import('../src/http.ts')
    const srv = await createHttpServer({ announce: false })
    try {
      const payload = (await (await fetch(`${srv.baseUrl}/verify`)).json()) as Record<string, unknown>
      const card = /<a class="card" id="verifyCard"[\s\S]*?<\/a>/.exec(all['index.html']!)?.[0]
      expect(card, 'the landing page no longer has a #verifyCard').toBeTypeOf('string')
      const claimed = [...card!.matchAll(/<code>([\w.]+)<\/code>/g)].map((m) => m[1]!)
      expect(claimed.length, 'the card names no field at all').toBeGreaterThan(2)
      expect(claimed.filter((k) => !(k in payload))).toEqual([])
    } finally {
      await srv.close()
    }
  })
})

describe('the hero frame names the version the chain is at', () => {
  it('labels the correction v3, the revision whose retraction it prints', async () => {
    /**
     * The frame said `→ v2` while the retraction on the same line — machine-checked
     * against renderRetraction() by the case above — is rendered from v2→v3. A
     * judge who runs `npm run e2e` sees `v3` and then sees `v2` on the page, which
     * reads as the illustration having been drawn rather than derived.
     */
    const { DEMO_NOW, RAY, STAGED_REVISION, seedDemo } = await import('../src/seed.ts')
    const store = seedDemo()
    store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    const latest = store.versions(RAY, 'weight_bearing').at(-1)!
    const shown = /weight_bearing → v(\d+)/.exec(all['index.html']!)?.[1]
    expect(shown, 'the hero no longer labels the corrected version').toBeTypeOf('string')
    expect(Number(shown)).toBe(latest.version)
  })
})

describe('reduced motion is the last word in every sheet', () => {
  /**
   * clinician.html declared `transition:none` for the inputs, every button and the
   * disclosure caret from an at-rule two hundred lines ABOVE the rules it cancels.
   * Measured in a browser with the preference set, three of its four declarations
   * did nothing: a later rule of equal specificity wins, and `input,textarea,button`
   * (0,0,1) loses outright to `input[type=text]` (0,1,1). CSS that declares a
   * behaviour it does not produce is the R6 shape living in a stylesheet.
   */
  const sheet = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)![1]!

  for (const page of PAGES) {
    it(`${page} closes its stylesheet with the reduced-motion at-rule`, () => {
      const css = sheet(all[page]!)
      const media = [...css.matchAll(/@media\s*\(([^)]*)\)/g)].map((m) => m[1]!.trim())
      expect(media.length, `${page} has no @media at all`).toBeGreaterThan(0)
      expect(media.at(-1), `${page} cancels motion before the rules it cancels`).toBe(
        'prefers-reduced-motion: reduce',
      )
    })
  }

  it('cancels the input transition at a specificity that can win', () => {
    // 0,1,1 to beat `input[type=text]`, not the 0,0,1 of a bare `input`.
    expect(sheet(all['clinician.html']!)).toContain(
      'input[type=text],input[type=password],textarea{transition:none}',
    )
  })
})

describe('the social card is a raster a scraper can render', () => {
  /**
   * `og:image` pointed at `/og.svg`. No major platform renders an SVG og:image and
   * most do not resolve a relative one, so the preview was blank everywhere the
   * repo link was pasted — and with no raster in the tree there was nothing to
   * upload for the Devpost gallery card either. R13: a great repo behind a weak
   * platform surface.
   */
  const png = readFileSync(join(REPO, 'docs/assets/og-image.png'))

  it('is a PNG of exactly 2400×1260 — the 1200×630 card every scraper crops to, exported at 2×', () => {
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(2400)
    expect(png.readUInt32BE(20)).toBe(1260)
  })

  it('is what every page names, with the dimensions and the alt text beside it', () => {
    for (const page of PAGES) {
      const html = all[page]!
      expect(html, page).toContain('<meta property="og:image" content="/og.png">')
      expect(html, page).toContain('<meta name="twitter:image" content="/og.png">')
      expect(html, page).toContain('<meta property="og:image:width" content="2400">')
      expect(html, page).toContain('<meta property="og:image:height" content="1260">')
      expect(html, page).toMatch(/<meta property="og:image:alt" content="[^"]{20,}">/)
      expect(html, page).toContain(`<meta property="og:url" content="/${page}">`)
      expect(html, page).not.toContain('content="/og.svg"')
    }
  })

  it('keeps both descriptions inside the length a preview will show', () => {
    for (const page of PAGES) {
      const html = all[page]!
      const og = /<meta property="og:description" content="([^"]*)"/.exec(html)![1]!
      const meta = /<meta name="description" content="([^"]*)"/.exec(html)![1]!
      expect(og.length, `${page} og:description`).toBeLessThanOrEqual(125)
      expect(meta.length, `${page} meta description`).toBeLessThanOrEqual(155)
    }
  })
})

describe('the clinician screen says how long ago in English', () => {
  /**
   * The page rendered "not updated for 9 days ago" — a duration preposition and a
   * past-tense adverb on one clause, in red, on the anticoagulant record, on the
   * screen a clinician is meant to trust. The `' ago'` suffix was appended outside
   * the branch. This executes the page's own expression rather than a copy of it.
   */
  const html = all['clinician.html']!
  const ageSrc = /function age\(fromIso, nowIso\) \{[\s\S]*?\n  \}/.exec(html)![0]!
  const expr = /el\('span', f\.stale \? 'stale-txt' : null,\n([\s\S]*?)\)\)\n/.exec(html)![1]!
  const line = new Function('f', 'state', `${ageSrc}\nreturn (${expr})`) as (
    f: { stale: boolean; lastModified: string },
    state: { now: string },
  ) => string

  const NOW = '2026-10-13T09:14:00.000Z'
  const NINE_DAYS = '2026-10-04T09:14:00.000Z'

  it('reads "not updated for 9 days", not "for 9 days ago"', () => {
    const stale = line({ stale: true, lastModified: NINE_DAYS }, { now: NOW })
    expect(stale).toBe('not updated for 9 days')
    expect(stale, 'a duration and a past-tense adverb on the same clause').not.toMatch(/for .* ago/)
  })

  it('still says "changed N ago" for a current record', () => {
    expect(line({ stale: false, lastModified: NINE_DAYS }, { now: NOW })).toBe('changed 9 days ago')
  })

  it('says "moments" rather than "0 seconds" right after a publish', () => {
    expect(line({ stale: false, lastModified: NOW }, { now: NOW })).toBe('changed moments ago')
  })
})

describe('the served pages are what a judge actually gets', () => {
  it('hands the landing page links that already carry a demo token', async () => {
    /**
     * All three links into the two live screens were bare `href="echo.html"`, so
     * clicking through from the page `npm start` prints first landed on a red "Not
     * connected" banner over a token entry form, with the product below the fold —
     * while the server held the tokens the whole time and printed them only into
     * the terminal. The mechanism worked; the judged path to it did not (R13).
     */
    const { createHttpServer } = await import('../src/http.ts')
    const srv = await createHttpServer({ announce: false })
    try {
      const body = await (await fetch(`${srv.baseUrl}/index.html`)).text()
      expect(body).toContain('href="echo.html?token=')
      expect(body).toContain('href="clinician.html?token=')
      // The raw hrefs stay in the file, so the link allowlist above still holds.
      expect(all['index.html']).toContain('href="echo.html"')
      // og:image cannot be relative and reach a scraper; the server absolutizes it.
      expect(body).toContain(`content="${srv.baseUrl}/og.png"`)
      expect(body).toContain(`content="${srv.baseUrl}/index.html"`)
    } finally {
      await srv.close()
    }
  })

  it('hands a fresh, still-valid token to every visitor, an hour later too', async () => {
    /**
     * The demo token was minted ONCE in the createHttpServer closure with the
     * one-hour mintToken default, and the dressed page was cached forever — so
     * after sixty minutes of `npm start` every judge who clicked the landing
     * page's own call to action landed on exactly the "not connected" dead end
     * the substitution was added to remove, and reloading returned the same dead
     * token. The realistic path — read the README, run the suite, the verify, the
     * bench, then follow DEMO.md — routinely passes an hour (LESSONS R13).
     */
    const { createHttpServer, verifyToken, DEV_TOKEN_SECRET } = await import('../src/http.ts')
    let clock = new Date('2026-10-08T09:14:00Z')
    const srv = await createHttpServer({ announce: false, now: () => clock })
    try {
      const tokenOn = async () => {
        const body = await (await fetch(`${srv.baseUrl}/index.html`)).text()
        return /href="echo\.html\?token=([^"&]+)"/.exec(body)![1]!
      }
      const first = await tokenOn()
      // Two hours later — well past the old one-hour TTL, and past any cache.
      clock = new Date(clock.getTime() + 2 * 3600_000)
      const later = await tokenOn()
      expect(later, 'the page served a cached token from two hours ago').not.toBe(first)
      const principal = verifyToken(later, {
        secret: DEV_TOKEN_SECRET,
        audience: srv.resourceUrl,
        now: clock,
      })
      expect(principal.scopes).toContain('care.read.user')

      // Twelve hours is what the page tells the reader it hands out.
      const claims = JSON.parse(Buffer.from(later.split('.')[1]!, 'base64url').toString('utf8'))
      expect(claims.exp - claims.iat).toBe(12 * 3600)
      expect(all['index.html'], 'the jump note misstates the link lifetime')
        .toContain('good for twelve hours')
    } finally {
      await srv.close()
    }
  })

  it('renders the five documents as HTML instead of handing over markdown source', async () => {
    /**
     * Every prose document the page links to was served `text/plain`, so a judge
     * following the footer or a Proof card got raw markdown in the browser's
     * default serif, edge to edge. The old allowlist test asserted each path
     * "returns 200 with the expected content" — true, green, and unreadable
     * (LESSONS R11).
     */
    const { createHttpServer } = await import('../src/http.ts')
    const { DOC_PAGES } = await import('../src/docpage.ts')
    const srv = await createHttpServer({ announce: false })
    try {
      for (const [path, doc] of Object.entries(DOC_PAGES)) {
        const res = await fetch(`${srv.baseUrl}${path}`)
        expect(res.status, path).toBe(200)
        expect(res.headers.get('content-type'), path).toContain('text/html')
        const body = await res.text()
        expect(body, path).toMatch(/<h1 id="[^"]*">/)
        expect(body, path).not.toContain('\n## ')
        // The raw source stays reachable for curl and for a diff.
        expect(body, path).toContain(`href="/${doc.file}"`)
        const raw = await fetch(`${srv.baseUrl}/${doc.file}`)
        expect(raw.headers.get('content-type'), doc.file).toContain('text/plain')
      }
    } finally {
      await srv.close()
    }
  })

  it('renders a table, a code fence and a resolved link, and escapes the rest', async () => {
    const { renderMarkdown } = await import('../src/docpage.ts')
    const out = renderMarkdown(
      '# Title\n\n| a | b |\n|---|---|\n| 1 | `2` |\n\n```bash\nnpm run verify\n```\n\n' +
        'See [the spec](docs/SPEC.md) and [nothing](src/nowhere.ts). <script>alert(1)</script>\n',
    )
    expect(out).toContain('<h1 id="title">Title</h1>')
    expect(out).toContain('<th>a</th>')
    expect(out).toContain('<code>2</code>')
    expect(out).toContain('<pre data-lang="bash"><code>npm run verify</code></pre>')
    expect(out).toContain('<a href="/doc/spec">the spec</a>')
    // A link this server answers nowhere is text, not a 404 waiting to happen.
    expect(out).toContain('<span class="unlinked">nothing</span>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })
})
