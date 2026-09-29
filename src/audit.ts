/**
 * Append-only audit log for the write path.
 *
 * Architecture invariant B: every attempt to change Ray's care plan is
 * attributable, whether it succeeded or not. A rejected write is the row that
 * matters — a stolen or malformed clinician key leaves a trail here and nowhere
 * else.
 *
 * `reason` is a closed union rather than a free-text string on purpose: a row
 * can therefore never carry the presented signature, the bearer token, or any
 * other attacker-supplied bytes, because there is nowhere in the row shape to
 * put them. That is a stronger guarantee than remembering to redact.
 */
import { appendFileSync } from 'node:fs'

export type AuditOutcome = 'accepted' | 'rejected'

export type AuditReason =
  | 'ok'
  | 'missing_signature'
  | 'bad_signature'
  | 'missing_timestamp'
  | 'stale_timestamp'
  | 'malformed_body'
  | 'invalid_fields'
  | 'insufficient_scope'
  | 'store_rejected'
  | 'body_too_large'
  /** A signed write already applied inside the skew window; answered, not re-applied. */
  | 'replayed'
  /** Identical to the current version; nothing published, nobody interrupted. */
  | 'unchanged'

/** How the writer authenticated. Never the credential itself. */
export type AuditVia = 'hmac' | 'bearer' | 'none'

export interface AuditRow {
  /** ISO 8601, server clock. */
  at: string
  /** Verified identity where one exists; `unverified` before authentication succeeds. */
  actor: string
  /** Target resource, or `-` when the body was never parsed. */
  uri: string
  outcome: AuditOutcome
  reason: AuditReason
  via: AuditVia
}

export interface AuditEntry {
  actor?: string
  uri?: string
  outcome: AuditOutcome
  reason: AuditReason
  via: AuditVia
}

export interface AuditOptions {
  /** JSONL file appended to on every row. Set from UNSAY_AUDIT_LOG. */
  sink?: string
  now?: () => Date
}

export class AuditLog {
  #rows: AuditRow[] = []
  #sink?: string
  #now: () => Date

  constructor(opts: AuditOptions = {}) {
    this.#sink = opts.sink
    // Refuse to start on a sink that cannot be appended to. Found at the first write
    // it turned a committed revision into an HTTP 500 and a "rejected" audit row.
    if (this.#sink) appendFileSync(this.#sink, '')
    this.#now = opts.now ?? (() => new Date())
  }

  append(entry: AuditEntry): AuditRow {
    const row: AuditRow = {
      at: this.#now().toISOString(),
      actor: entry.actor ?? 'unverified',
      uri: entry.uri ?? '-',
      outcome: entry.outcome,
      reason: entry.reason,
      via: entry.via,
    }
    this.#rows.push(row)
    if (this.#sink) {
      // Sync append: an audit row that is lost because the process exited first
      // is worse than a millisecond on the write path.
      appendFileSync(this.#sink, JSON.stringify(row) + '\n')
    }
    return row
  }

  /** Read-only view. No method mutates or removes rows — the log is append-only. */
  rows(): readonly AuditRow[] {
    return this.#rows
  }

  get length(): number {
    return this.#rows.length
  }

  last(): AuditRow | undefined {
    return this.#rows.at(-1)
  }

  rejected(): readonly AuditRow[] {
    return this.#rows.filter((r) => r.outcome === 'rejected')
  }
}
