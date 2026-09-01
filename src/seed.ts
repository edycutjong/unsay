/**
 * Deterministic seed — Ray Dunn's post-operative record.
 *
 * Six records, not six hundred. The contribution is a mechanism, not a corpus,
 * and every record has a named job in the 3-minute demo (../specs/seed-data.md).
 *
 * All dates are constants relative to DEMO_NOW so `seed()` is byte-identical on
 * every run. The v2 revision is deliberately NOT applied here — it is fired live
 * during the demo, so the notification a judge sees is a real one.
 */
import type { LiveResourceStore } from './store.ts'

export const RAY = 'ray'

/** Pinned "now" for the demo. Everything else is relative to it. */
export const DEMO_NOW = new Date('2026-10-08T09:14:00Z')

const daysBefore = (n: number) =>
  new Date(DEMO_NOW.getTime() - n * 86_400_000).toISOString()

export function seed(store: LiveResourceStore) {
  // ── speakable ──────────────────────────────────────────────────────────────
  store.publish({
    patient: RAY,
    domain: 'weight_bearing',
    audience: 'user',
    value: 'Partial weight-bearing, about half your body weight through the operated leg.',
    authorId: 'adeyemi',
    authorLabel: 'Mr Adeyemi, surgical team',
    writtenAt: daysBefore(2),
    priority: 0.9,
  })

  store.publish({
    patient: RAY,
    domain: 'anticoagulant',
    audience: 'user',
    value: 'Rivaroxaban 10mg once daily. Stop date: 4 October 2026.',
    authorId: 'gp.mensah',
    authorLabel: 'Dr Mensah, GP',
    writtenAt: daysBefore(9),
    // already passed at DEMO_NOW — this record must announce its own age
    staleAfter: '2026-10-04T00:00:00Z',
    priority: 0.85,
  })

  store.publish({
    patient: RAY,
    domain: 'exercise',
    audience: 'user',
    value:
      'Ankle pumps hourly. Heel slides ten times, twice daily. No hip flexion past ninety degrees.',
    authorId: 'okafor',
    authorLabel: 'Sarah Okafor, physio',
    writtenAt: daysBefore(1),
    priority: 0.6,
  })

  store.publish({
    patient: RAY,
    domain: 'contact',
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
    patient: RAY,
    domain: 'risk',
    audience: 'assistant',
    value:
      'Fall risk: HIGH. Lives alone Monday to Thursday. Family disputes the discharge plan — daughter believes discharge was premature.',
    authorId: 'adeyemi',
    authorLabel: 'Mr Adeyemi, surgical team',
    writtenAt: daysBefore(5),
    priority: 1.0,
  })

  store.publish({
    patient: RAY,
    domain: 'adherence',
    audience: 'assistant',
    value: 'Reported adherence unreliable; over-reports exercise completion.',
    authorId: 'okafor',
    authorLabel: 'Sarah Okafor, physio',
    writtenAt: daysBefore(3),
    priority: 0.7,
  })

  return store
}

/**
 * The revision fired LIVE on stage. Not applied by seed().
 * This is the thirty seconds that the whole product exists for.
 */
export const STAGED_REVISION = {
  patient: RAY,
  domain: 'weight_bearing',
  audience: 'user' as const,
  value: 'Full weight-bearing as tolerated.',
  authorId: 'okafor',
  authorLabel: 'Sarah Okafor, physio',
  priority: 0.9,
}
