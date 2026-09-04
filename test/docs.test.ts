/**
 * The documents, checked against the things they describe.
 *
 * LESSONS R6, eight prior losses: documentation describing behaviour that was
 * never built. The repo already generates ARCHITECTURE.md from the source and
 * writes the landing page's latency figures out of the run that measured them.
 * These are the claims that were still transcribed by hand — and every one of them
 * had drifted:
 *
 *   · README.md and DEMO.md quoted a bench table matching no run that ever happened,
 *     while both asserted "that is the committed run in docs/proof/bench.txt";
 *   · docs/SPEC.md cited a test that does not exist, and pointed nine invariants at
 *     a file the code had moved out of;
 *   · DEMO.md sent a judge to `src/store.ts read()`, which is a dead end.
 *
 * A document is not a lower standard of truth than a function.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')

const README = read('README.md')
const DEMO = read('DEMO.md')
const SPEC = read('docs/SPEC.md')
const FRICTION = read('FRICTION.md')

const norm = (s: string) => s.split(/\s+/).filter(Boolean).join(' ')

describe('the bench table is the run that produced it', () => {
  const benchTxt = read('docs/proof/bench.txt')
  const block = (doc: string, name: string) => {
    const m = /<!-- bench:begin[^>]*-->\n```\n([\s\S]*?)\n```\n<!-- bench:end -->/.exec(doc)
    expect(m, `${name} has no bench:begin/bench:end block`).not.toBeNull()
    return m![1]!
  }

  it('quotes the same table in README.md and DEMO.md', () => {
    expect(block(README, 'README.md')).toBe(block(DEMO, 'DEMO.md'))
  })

  it('quotes only lines that are in docs/proof/bench.txt', () => {
    // `npm run bench` writes the receipt and both documents from one run. A line
    // here that is not in the receipt is a number nobody measured.
    const receipt = new Set(benchTxt.split('\n').map(norm))
    const quoted = block(README, 'README.md').split('\n').map(norm).filter(Boolean)
    expect(quoted.length).toBeGreaterThan(4)
    expect(quoted.filter((l) => !receipt.has(l))).toEqual([])
  })

  it('carries the two lines that must not change, and the caveat', () => {
    const quoted = block(README, 'README.md')
    expect(quoted).toMatch(/retraction lands mid-sentence in (\d+)\/\1 runs \(100%\)/)
    expect(quoted).toContain('a host was subscribed for every run: yes')
    for (const doc of [README, DEMO]) expect(doc).toContain('docs/proof/bench.txt')
  })

  it('never quotes a millisecond figure outside that block', () => {
    // The failure this catches: a second, hand-typed copy of the number elsewhere
    // in the document, which is how the first one drifted.
    for (const [name, doc] of [['README.md', README], ['DEMO.md', DEMO]] as const) {
      const outside = doc.replace(/<!-- bench:begin[^>]*-->[\s\S]*?<!-- bench:end -->/g, '')
      const figures = outside.match(/\b\d+\.\d+\s?ms\b/g) ?? []
      // e2e's per-run notification latency is explicitly labelled as varying.
      expect(figures.filter((f) => !outside.includes(`${f}\` will differ`)), name).toEqual([])
    }
  })
})

describe('every test docs/SPEC.md cites exists', () => {
  /**
   * SPEC is structured as a claim-to-assertion index and stakes its credibility on
   * that index being checkable. One citation — I-8's "does not fire updated for the
   * first version" — greped to nothing, which converts the document's greatest
   * strength into evidence for R6. This is the cheap check that stops it recurring.
   */
  const suite = ['test/store.test.ts', 'test/server.test.ts', 'test/http.test.ts',
    'test/envelope.test.ts', 'test/retraction.test.ts', 'test/docs.test.ts',
    'web/web.test.ts', 'packages/live-resources/test/live-resources.test.ts']
  const names = new Set(
    suite.flatMap((f) =>
      [...read(f).matchAll(/\b(?:it|test)\(\s*(['"`])([\s\S]*?)\1/g)].map((m) => norm(m[2]!)),
    ),
  )

  const cited = [
    ...new Set(
      [...SPEC.matchAll(/\*\*Asserted by\.\*\*([\s\S]*?)\n\n/g)].flatMap((p) =>
        [...p[1]!.matchAll(/\*"([\s\S]*?)"\*/g)].map((m) => norm(m[1]!)),
      ),
    ),
  ]

  it('cites a substantial number of them, or this test proves nothing', () => {
    expect(cited.length).toBeGreaterThan(40)
    expect(names.size).toBeGreaterThan(100)
  })

  it('names no test that does not exist', () => {
    expect(cited.filter((c) => !names.has(c))).toEqual([])
  })
})

describe('SPEC references the files the code is actually in', () => {
  it('points no invariant at src/store.ts, which is now a 116-line adapter', () => {
    /**
     * Nine invariants named `src/store.ts › read()`, `publish()`, `verify()` and so
     * on after the day-7 extraction moved every one of them into the package. The
     * first grep a judge runs came back empty on a document whose preamble invites
     * exactly that grep.
     */
    for (const symbol of ['read()', 'publish()', 'verify()', 'staleness()', 'list()',
      'hashVersion()', 'annotationsFor()', '#seal()/#open()']) {
      expect(SPEC, `SPEC still points at src/store.ts › ${symbol}`)
        .not.toContain(`\`src/store.ts › ${symbol}`)
    }
    const adapter = read('src/store.ts')
    for (const symbol of ['read(', 'publish(', 'verify(', 'staleness(', 'annotationsFor']) {
      expect(adapter, `src/store.ts unexpectedly contains ${symbol}`).not.toContain(symbol)
    }
  })

  it('names a symbol that is greppable in each file it sends a reader to', () => {
    const pairs: [string, string][] = [
      ['packages/live-resources/src/store.ts', 'read('],
      ['packages/live-resources/src/store.ts', 'publish('],
      ['packages/live-resources/src/store.ts', 'staleness('],
      ['packages/live-resources/src/store.ts', 'annotationsFor'],
      ['packages/live-resources/src/chain.ts', 'hashVersion'],
      ['packages/live-resources/src/errors.ts', 'NotFoundError'],
      ['packages/live-resources/src/notifier.ts', 'ResourceNotifier'],
      ['src/server.ts', 'logRevision'],
      ['src/server.ts', 'armListChanged'],
      ['src/retraction.ts', 'renderRetraction'],
      ['src/ui_resource.ts', 'UI_ECHO_URI'],
      ['src/audit.ts', 'append('],
      ['src/http.ts', 'handleWrite'],
    ]
    for (const [file, symbol] of pairs) {
      expect(SPEC, `SPEC should reference ${file}`).toContain(file)
      expect(read(file), `${file} › ${symbol}`).toContain(symbol)
    }
  })

  it('names no mechanism that exists nowhere in the source', () => {
    // `queueMicrotask` was documented as the list_changed suppression window for a
    // day after the real mechanism became "arm on the first list served" — a named
    // mechanism a judge could grep for and not find.
    const source = ['src/server.ts', 'src/http.ts', 'packages/live-resources/src/notifier.ts']
      .map(read)
      .join('\n')
    // Only the "Where enforced" paragraphs are scanned: naming a mechanism that was
    // REMOVED, and saying so, is the honest form and appears elsewhere on purpose.
    const enforced = [...SPEC.matchAll(/\*\*Where enforced\.\*\*([\s\S]*?)\n\n\*\*/g)]
      .map((m) => m[1]!)
      .join('\n')
    expect(enforced.length).toBeGreaterThan(2000)
    for (const mechanism of ['queueMicrotask', 'store.onUpdated', 'server.sendResourceUpdated']) {
      if (!source.includes(mechanism)) {
        expect(enforced, `SPEC enforces via ${mechanism}, which is in no source file`)
          .not.toContain(mechanism)
      }
    }
  })
})

describe('the counts in the documents are the counts', () => {
  it('agrees with the friction log about how many entries it has', () => {
    const entries = (FRICTION.match(/^## F-0\d+/gm) ?? []).length
    expect(entries).toBeGreaterThan(10)
    const words: Record<number, string> = { 12: 'twelve', 13: 'thirteen', 14: 'fourteen' }
    expect(README, 'README miscounts FRICTION.md').toContain(`${words[entries]} entries`)
    expect(FRICTION.toLowerCase()).toContain(`${words[entries]} entries.`)
  })

  it('agrees with the verify receipt about how many assertions it makes', () => {
    const receipt = JSON.parse(read('docs/proof/verify.json'))
    expect(receipt.verdict).toBe('PASS')
    const spelled: Record<number, string> = { 29: 'Twenty-nine', 33: 'Thirty-three' }
    expect(README).toContain(`${spelled[receipt.assertions]} assertions`)
    expect(DEMO).toContain(`${receipt.assertions} assertions`)
  })

  it('agrees with the e2e receipt about how many frames it wrote', () => {
    const lines = read('docs/proof/live_run.jsonl').trim().split('\n')
    const summaries = lines.filter((l) => JSON.parse(l).event === 'summary').length
    expect(summaries).toBe(1)
    // "N frames plus a summary" used to describe N+1 lines for an N-line file.
    expect(DEMO).toContain(`${lines.length} lines: ${lines.length - 1} frames`)
  })

  it('agrees with the resume receipt about what it replayed', () => {
    const resume = JSON.parse(read('docs/proof/resume.json'))
    expect(resume.verdict).toBe('PASS')
    expect(resume.revisions.missedCount).toBeGreaterThan(1)
    const words: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four' }
    expect(SPEC, 'SPEC misstates how many revisions the probe writes into the dark')
      .toContain(`**${words[resume.revisions.missedCount]}** further revisions`)
  })

  it('quotes only VERDICT lines the scripts actually print', () => {
    /**
     * README once quoted `VERDICT: PASS   (6/6 checks)` inside a fenced block a
     * judge is invited to reproduce, and the `(6/6 checks)` suffix existed nowhere
     * in the source. It exists now — the script prints the count — and this asserts
     * that whatever shape the documents quote is a shape the script can emit.
     */
    const probe = read('scripts/probe_resume.ts')
    const quoted = [...README.matchAll(/^ *VERDICT: (?:PASS|FAIL)(.*)$/gm),
      ...DEMO.matchAll(/^ *VERDICT: (?:PASS|FAIL)(.*)$/gm)]
      .map((m) => m[1]!.trim())
    expect(quoted.length, 'no VERDICT line is quoted anywhere').toBeGreaterThan(0)
    for (const suffix of quoted) {
      if (suffix === '') continue
      expect(/^\(\d+\/\d+ checks\)$/.test(suffix), `unexpected VERDICT suffix "${suffix}"`).toBe(true)
      expect(probe, 'probe_resume.ts prints no check count').toContain('checks)`')
    }
  })
})

describe('the drawn artwork says what the code says', () => {
  it('opens the retraction with the same clause renderRetraction() does', async () => {
    /**
     * The hero and the social card are illustrations, and an illustration is a
     * fourth place for the sentence to drift. They carry the opening clause the
     * server actually renders, and this fails when it changes.
     */
    const { renderRetraction } = await import('../src/retraction.ts')
    const { DEMO_NOW, RAY, STAGED_REVISION, seedDemo } = await import('../src/seed.ts')
    const store = seedDemo()
    store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    const chain = store.versions(RAY, 'weight_bearing')
    const opening = renderRetraction(chain.at(-2)!, chain.at(-1)!).split('.')[0]! + '.'
    for (const art of ['docs/readme-hero.svg', 'docs/og.svg']) {
      expect(read(art), art).toContain(opening)
      expect(read(art), `${art} still shows a retired wording`).not.toContain('actually, stop')
    }
  })

  it('labels the hero as an illustration rather than a recording', () => {
    expect(read('docs/readme-hero.svg')).toContain('Illustration of the mechanism')
    expect(README).toContain('illustration of the mechanism')
  })
})

describe('the judge-facing pointers land on something', () => {
  it('sends a judge to the file the enforcement point is actually in', () => {
    expect(DEMO).toContain('`packages/live-resources/src/store.ts` `read()`')
    expect(DEMO).not.toMatch(/`src\/store\.ts` `read\(\)`/)
  })

  it('names the track requirement a judge has to be able to find', () => {
    // The Alexa+ track's one hard eligibility requirement. It was satisfied and
    // stated nowhere, so it had to be inferred from a caret range in package.json.
    for (const [name, doc] of [['README.md', README], ['ARCHITECTURE.md', read('ARCHITECTURE.md')]] as const) {
      expect(doc, name).toContain('2025-11-25')
      expect(doc, name).toContain('Streamable HTTP')
    }
  })

  it('links the two Alexa+ artifacts that only exist because of the track', () => {
    expect(README).toContain('skill/SKILL.md')
    expect(README).toContain('ui://unsay/echo')
    expect(read('skill/SKILL.md')).toContain('name: unsay-care-plan')
  })
})
