/**
 * The hash chain, and the string it binds sealed bytes to.
 *
 * Every revision hashes its predecessor, so "this fact is current" and "this fact
 * descends from the one you were told a minute ago" become checkable claims rather
 * than assertions the server makes about itself. A client that read v2 and is
 * notified of v3 can prove v3 follows the exact v2 it holds; an auditor holding
 * only the log can replay the whole chain without the server's cooperation.
 */
import { createHash } from 'node:crypto'
import { ReservedSeparatorError } from './errors.ts'
import type { Audience } from './types.ts'

/** JSON.stringify of a string: one unambiguous byte sequence per value. */
const canonical = (value: string) => JSON.stringify(value)

/**
 * SHA-256(prev ‖ canonical(value) ‖ writtenAt ‖ authorId).
 *
 * The author is in the hash on purpose: two people writing identical text at the
 * same instant are two different events, and a chain that cannot tell them apart
 * cannot answer "who changed it".
 */
export function hashVersion(
  prev: string | null,
  value: string,
  writtenAt: string,
  authorId: string,
): string {
  return createHash('sha256')
    .update(prev ?? '')
    .update(canonical(value))
    .update(writtenAt)
    .update(authorId)
    .digest('hex')
}

/** The four fields that name exactly one revision of one resource. */
export interface RecordIdentity {
  subject: string
  topic: string
  version: number
  audience: Audience
}

export const AAD_SEPARATOR = '|'

/**
 * The authenticated-data string a codec binds ciphertext to.
 *
 * This is what closes the hole the scope check cannot: an attacker with WRITE
 * access to storage can move bytes between slots, and a read-time scope check
 * happily serves whatever it finds in the slot it was allowed to read. Bound to
 * `subject|topic|v<n>|audience`, sealed bytes only open in the exact slot they
 * were sealed in — moved across the audience boundary, they fail to decrypt.
 *
 * The separator is therefore reserved: a component containing one could make two
 * distinct identities collide into a single AAD, which is the whole property.
 */
export function recordAad(id: RecordIdentity): string {
  for (const part of [id.subject, id.topic, id.audience]) {
    if (part.includes(AAD_SEPARATOR)) {
      throw new ReservedSeparatorError(
        `"${AAD_SEPARATOR}" is reserved in a record identity: ${part}`,
      )
    }
  }
  return `${id.subject}${AAD_SEPARATOR}${id.topic}${AAD_SEPARATOR}v${id.version}${AAD_SEPARATOR}${id.audience}`
}
