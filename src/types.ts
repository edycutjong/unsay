/**
 * Core types. The audience split is expressed in the TYPE SYSTEM as well as at
 * runtime, so a resource cannot be constructed without declaring who may hear it.
 */

/** MCP annotation audience values — exactly the two the 2025-11-25 spec allows. */
export type Audience = 'user' | 'assistant'

/**
 * URI scheme carries the audience. This is the enforcement primitive: the scheme
 * is decided server-side from the record, never from a client hint, so a client
 * that ignores `annotations.audience` still cannot reach assistant-only content —
 * it is never sent a `care-internal://` URI it has scope for.
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

export interface Annotations {
  /** Who may receive this content. */
  audience: Audience[]
  /** 0.0–1.0 — how important this is relative to other resources. */
  priority?: number
  /** ISO 8601. Drives self-announcing staleness. */
  lastModified?: string
}

export interface CareRecord {
  patient: string
  domain: string
  version: number
  audience: Audience
  value: string
  authorId: string
  authorLabel: string
  writtenAt: string
  /** ISO 8601. Past this, the fact must announce its own age when spoken. */
  staleAfter?: string
  priority: number
  /** SHA-256(prev ‖ canonical(value) ‖ writtenAt ‖ authorId) */
  versionHash: string
  prevHash: string | null
}

export interface Principal {
  sub: string
  scopes: string[]
}

/** Result of replaying a version chain. */
export interface ChainVerdict {
  uri: string
  versions: number
  intact: boolean
  brokenAt?: number
  expected?: string
  actual?: string
}
