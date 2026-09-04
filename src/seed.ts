/**
 * Deterministic seed — Ray Dunn's post-operative record, day 5 after a hip
 * replacement.
 *
 * A handful of records, not a corpus. The contribution is a mechanism, and every
 * record has a named job in the three-minute demo.
 *
 * Determinism: every date is derived from an injected clock (`SeedOptions.now`,
 * default DEMO_NOW), never from `Date.now()`, so two runs produce byte-identical
 * records and therefore byte-identical version hashes. The hash chain is the
 * staleness proof; a seed that drifted with wall-clock time would make it
 * unverifiable.
 *
 * The v-next revision of weight_bearing is deliberately NOT applied here — it is
 * fired live during the demo, so the notification a judge sees is a real one.
 */
import { LiveResourceStore, uriFor } from './store.ts'
import { CLIPS, blobFor } from './blobs.ts'

export const RAY = 'ray'

/** Pinned "now" for the demo. Everything else is relative to it. */
export const DEMO_NOW = new Date('2026-10-08T09:14:00Z')

export interface SeedOptions {
  /** Injected clock. All record timestamps are offsets from it. */
  now?: Date
}

/**
 * "4 October 2026" — the form a discharge letter writes a stop date in, and the
 * form the record's own sentence has to be in for a human who hears it read out
 * to notice that the date has gone by.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December']
const spokenDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function seed(store: LiveResourceStore, opts: SeedOptions = {}) {
  const now = opts.now ?? DEMO_NOW
  const daysBefore = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString()

  // ── speakable ──────────────────────────────────────────────────────────────
  // Day 1: what the surgical team said before it was superseded. Present so the
  // retraction has a real previous version to walk back to, not an implied one —
  // completion/complete over {version} and the `_meta` prevHash chain only
  // demonstrate anything against a chain longer than one.
  store.publish({
    subject: RAY,
    topic: 'weight_bearing',
    audience: 'user',
    value: 'No weight through the operated leg. Transfers with the frame only.',
    authorId: 'adeyemi',
    authorLabel: 'Mr Adeyemi, surgical team',
    writtenAt: daysBefore(4),
    priority: 0.9,
  })

  store.publish({
    subject: RAY,
    topic: 'weight_bearing',
    audience: 'user',
    value: 'Partial weight-bearing, about half your body weight through the operated leg.',
    authorId: 'adeyemi',
    authorLabel: 'Mr Adeyemi, surgical team',
    writtenAt: daysBefore(2),
    priority: 0.9,
  })

  // Relative to the injected clock, not a pinned date. An absolute stop date is
  // only "already passed" on one particular day; every other day — including any
  // day a judge runs `npm start` — this record quietly stops being stale and the
  // one feature it exists to demonstrate goes dark. Four days back from now is
  // 2026-10-04 at DEMO_NOW, so the pinned receipts are unchanged.
  //
  // The SENTENCE is derived from the same instant. It was left pinned to
  // "4 October 2026" when `staleAfter` was made relative, so the live server
  // served a record flagged "past its review date" whose own words named a stop
  // date a month in the FUTURE — the one narrative the product rests on,
  // demonstrated on a drug the patient had not been told to stop. docs/SPEC.md
  // I-7 states the opposite as the reason the feature exists; verify §9 now
  // asserts the date in the text has actually passed.
  const stopDate = daysBefore(4)
  store.publish({
    subject: RAY,
    topic: 'anticoagulant',
    audience: 'user',
    value: `Rivaroxaban 10mg once daily. Stop date: ${spokenDate(stopDate)}.`,
    authorId: 'gp.mensah',
    authorLabel: 'Dr Mensah, GP',
    writtenAt: daysBefore(9),
    staleAfter: stopDate,
    priority: 0.85,
  })

  store.publish({
    subject: RAY,
    topic: 'exercise',
    audience: 'user',
    value:
      'Ankle pumps hourly. Heel slides ten times, twice daily. No hip flexion past ninety degrees.',
    authorId: 'okafor',
    authorLabel: 'Sarah Okafor, physio',
    writtenAt: daysBefore(1),
    priority: 0.6,
  })

  store.publish({
    subject: RAY,
    topic: 'contact',
    audience: 'user',
    value: 'Ward 4 physio line, weekdays nine to five. Out of hours, call 111.',
    authorId: 'ward4',
    authorLabel: 'Ward 4 admin',
    writtenAt: daysBefore(5),
    priority: 0.3,
  })

  // ── never speakable ────────────────────────────────────────────────────────
  // Shapes the answer ("have someone nearby") and is never said to Ray.
  store.publish({
    subject: RAY,
    topic: 'risk',
    audience: 'assistant',
    value:
      'Fall risk: HIGH. Lives alone Monday to Thursday. Family disputes the discharge plan — daughter believes discharge was premature.',
    authorId: 'adeyemi',
    authorLabel: 'Mr Adeyemi, surgical team',
    writtenAt: daysBefore(5),
    priority: 1.0,
  })

  store.publish({
    subject: RAY,
    topic: 'adherence',
    audience: 'assistant',
    value: 'Reported adherence unreliable; over-reports exercise completion.',
    authorId: 'okafor',
    authorLabel: 'Sarah Okafor, physio',
    writtenAt: daysBefore(3),
    priority: 0.7,
  })

  // ── clips ──────────────────────────────────────────────────────────────────
  // The record carries the words; blobs.ts carries the bytes. Both live behind the
  // same URI, so the audience partition that guards the text guards the audio too.
  for (const clip of CLIPS) {
    const meta = blobFor(uriFor(clip.patient, clip.domain, clip.audience))!
    const speakable = clip.audience === 'user'
    store.publish({
      subject: clip.patient,
      topic: clip.domain,
      audience: clip.audience,
      value: meta.description,
      authorId: 'okafor',
      authorLabel: 'Sarah Okafor, physio',
      writtenAt: daysBefore(speakable ? 1 : 2),
      priority: speakable ? 0.55 : 0.8,
    })
  }

  return store
}

/**
 * The store the demo and the server run on. Identical to `seed()` — kept as the
 * name every entrypoint reaches for, and because `seedDemo()` reads as an
 * intention where `seed(new LiveResourceStore())` reads as plumbing.
 */
export function seedDemo(store?: LiveResourceStore, opts: SeedOptions = {}) {
  return seed(store ?? new LiveResourceStore(), opts)
}

/**
 * The revision fired LIVE on stage. Not applied by seed().
 * This is the thirty seconds that the whole product exists for.
 */
export const STAGED_REVISION = {
  subject: RAY,
  topic: 'weight_bearing',
  audience: 'user' as const,
  value: 'Full weight-bearing as tolerated.',
  authorId: 'okafor',
  authorLabel: 'Sarah Okafor, physio',
  priority: 0.9,
}
