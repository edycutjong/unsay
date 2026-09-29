/**
 * The shapes. Nothing here is domain-specific: a record is a versioned string
 * with an author, a time, and an audience.
 */

/**
 * MCP `annotations.audience` — exactly the two values the specification allows.
 * `user` is content that may be shown or spoken to the human; `assistant` is
 * content that may shape the model's answer and must never be part of it.
 */
export type Audience = 'user' | 'assistant'

/** The subset of MCP resource annotations a live store can fill in by itself. */
export interface Annotations {
  audience: Audience[]
  /** 0.0-1.0, how important this resource is relative to the others. */
  priority?: number
  /** ISO 8601 timestamp of the revision being served. */
  lastModified?: string
}

/**
 * One revision of one resource. `subject` and `topic` are the two path segments
 * of its URI: `subject` is who or what the record is about, `topic` is which of
 * that subject's facts it carries. Together they name a CHAIN; `version` picks a
 * link in it.
 */
export interface LiveRecord {
  subject: string
  topic: string
  version: number
  audience: Audience
  /** Plaintext on the way in and on the way out, whatever the codec does at rest. */
  value: string
  authorId: string
  authorLabel: string
  /** ISO 8601. Becomes `annotations.lastModified`. */
  writtenAt: string
  /** ISO 8601. Past this, the fact should announce its own age rather than be read flat. */
  staleAfter?: string
  priority: number
  /** SHA-256(prevHash ‖ canonical(value) ‖ writtenAt ‖ authorId) */
  versionHash: string
  /** null at v1. */
  prevHash: string | null
}

export interface PublishInput {
  subject: string
  topic: string
  audience: Audience
  value: string
  authorId: string
  authorLabel: string
  /** ISO 8601. Passed in rather than read from the clock so chains are reproducible. */
  writtenAt: string
  staleAfter?: string
  /** Defaults to 0.5. */
  priority?: number
}

/** Whoever is asking. `scopes` is the only thing the store consults. */
export interface Principal {
  sub: string
  scopes: string[]
}

/** Result of replaying a chain's hashes. `brokenAt` is the first bad version. */
export interface ChainVerdict {
  uri: string
  versions: number
  intact: boolean
  brokenAt?: number
  expected?: string
  actual?: string
}

/** How old the newest revision is, and whether it has outlived its own date. */
export interface Staleness {
  ageMs: number
  stale: boolean
  lastModified: string
  versionHash: string
  staleAfter?: string
}

/**
 * What the stored bytes say about themselves. The shape is FIXED whether or not a
 * codec is configured — a receipt whose fields appear and disappear cannot be
 * diffed, and "is this actually encrypted?" is a question that deserves the same
 * answer shape either way.
 */
export interface AtRestReceipt {
  uri: string
  versionHash: string
  encrypted: boolean
  algorithm: string
  provider: string | null
  keyId: string | null
  /** The authenticated-data string these bytes are bound to, or null in plaintext. */
  aad: string | null
  ivHex: string | null
  tagHex: string | null
  ciphertextBytes: number | null
}

export type UpdatedListener = (uri: string) => void
/** Receives the new chain's unversioned URI, so a notifier can withhold it from a principal without scope. */
export type ListChangedListener = (uri: string) => void
/** Every `on*` subscription returns its own unsubscribe. */
export type Unsubscribe = () => void
