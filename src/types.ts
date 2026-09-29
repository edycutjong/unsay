/**
 * Unsay's types: the two constants that make the audience split real, and care
 * names for the shapes the store works in.
 *
 * The shapes themselves come from `@unsay/live-resources` — redeclaring them here
 * would be two definitions of one record that drift the first time either moves.
 * What this file owns is the part the package deliberately does NOT decide: which
 * scheme and which scope each audience gets.
 */
export type { Annotations, Audience, ChainVerdict, Principal } from '../packages/live-resources/src/index.ts'
import type { Audience, LiveRecord } from '../packages/live-resources/src/index.ts'

/**
 * A care record is a live record: the package's `subject` is Ray, its `topic` is
 * the care domain (`weight_bearing`, `risk`). The care words survive in Unsay's own
 * vocabulary — the HTTP write body, the URI templates, the prompt arguments — and
 * stop at the store's edge.
 */
export type CareRecord = LiveRecord

/**
 * URI scheme carries the audience. This is the enforcement primitive: the scheme
 * is decided server-side from the record, never from a client hint, so a client
 * that ignores `annotations.audience` still cannot reach assistant-only content —
 * it is never sent a `care-internal://` URI it has no scope for.
 *
 * See FRICTION.md F-002: the spec places no obligation on a client to honour
 * `audience`, so it cannot be the control for a safety boundary.
 */
export const SCHEME: Record<Audience, string> = {
  user: 'care://',
  assistant: 'care-internal://',
}

/** OAuth scope required to read each scheme. */
export const SCOPE: Record<Audience, string> = {
  user: 'care.read.user',
  assistant: 'care.read.assistant',
}
