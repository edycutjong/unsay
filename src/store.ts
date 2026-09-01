/**
 * LiveResourceStore — the generic half of Unsay.
 *
 * Any MCP server publishing mutable state needs this: revisions that fire
 * notifications, a hash chain so staleness is provable rather than claimed, and
 * an audience partition enforced at read time.
 *
 * This is what gets extracted to `@unsay/live-resources` (Open Source mini).
 * Nothing in this file knows about hips, physios, or Alexa.
 */
import { createHash } from 'node:crypto'
import {
  type Annotations,
  type Audience,
  type CareRecord,
  type ChainVerdict,
  type Principal,
  SCHEME,
  SCOPE,
} from './types.ts'

/** Thrown when a principal reads a URI it has no scope for. Maps to JSON-RPC -32002. */
export class NotFoundError extends Error {
  readonly code = -32002
  constructor(uri: string) {
    // Deliberately indistinguishable from "does not exist". A principal without
    // the scope must not be able to probe for the EXISTENCE of internal records.
    super(`Resource not found: ${uri}`)
  }
}

const canonical = (v: string) => JSON.stringify(v)

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

export function uriFor(patient: string, domain: string, audience: Audience, version?: number) {
  const base = `${SCHEME[audience]}${patient}/${domain}`
  return version === undefined ? base : `${base}/v${version}`
}

export interface PublishInput {
  patient: string
  domain: string
  audience: Audience
  value: string
  authorId: string
  authorLabel: string
  writtenAt: string
  staleAfter?: string
  priority?: number
}

export type UpdatedListener = (uri: string) => void

export class LiveResourceStore {
  /** key = `${patient}/${domain}` → versions, oldest first */
  #chains = new Map<string, CareRecord[]>()
  #listeners: UpdatedListener[] = []

  onUpdated(fn: UpdatedListener) {
    this.#listeners.push(fn)
    return () => {
      this.#listeners = this.#listeners.filter((f) => f !== fn)
    }
  }

  #key(patient: string, domain: string) {
    return `${patient}/${domain}`
  }

  /** Append a new version. Fires `updated` for every version after the first. */
  publish(input: PublishInput): CareRecord {
    const key = this.#key(input.patient, input.domain)
    const chain = this.#chains.get(key) ?? []
    const prev = chain.at(-1) ?? null

    if (prev && prev.audience !== input.audience) {
      // An audience flip would silently move a fact across the safety boundary.
      throw new Error(
        `refusing to change audience of ${key} from "${prev.audience}" to "${input.audience}"`,
      )
    }

    const record: CareRecord = {
      patient: input.patient,
      domain: input.domain,
      version: (prev?.version ?? 0) + 1,
      audience: input.audience,
      value: input.value,
      authorId: input.authorId,
      authorLabel: input.authorLabel,
      writtenAt: input.writtenAt,
      staleAfter: input.staleAfter,
      priority: input.priority ?? 0.5,
      prevHash: prev?.versionHash ?? null,
      versionHash: hashVersion(
        prev?.versionHash ?? null,
        input.value,
        input.writtenAt,
        input.authorId,
      ),
    }

    this.#chains.set(key, [...chain, record])

    if (prev) {
      const uri = uriFor(input.patient, input.domain, input.audience)
      for (const fn of this.#listeners) fn(uri)
    }
    return record
  }

  /** Every URI a principal is ALLOWED to know exists. */
  list(principal: Principal): { record: CareRecord; uri: string }[] {
    const out: { record: CareRecord; uri: string }[] = []
    for (const chain of this.#chains.values()) {
      const latest = chain.at(-1)!
      if (!principal.scopes.includes(SCOPE[latest.audience])) continue
      out.push({ record: latest, uri: uriFor(latest.patient, latest.domain, latest.audience) })
    }
    return out
  }

  /**
   * Read by URI. THE enforcement point.
   *
   * A principal without the scope for this URI's scheme gets NotFoundError —
   * not "forbidden", which would confirm the record exists.
   */
  read(uri: string, principal: Principal): CareRecord {
    const parsed = parseUri(uri)
    if (!parsed) throw new NotFoundError(uri)

    if (!principal.scopes.includes(SCOPE[parsed.audience])) {
      throw new NotFoundError(uri)
    }

    const chain = this.#chains.get(this.#key(parsed.patient, parsed.domain))
    if (!chain?.length) throw new NotFoundError(uri)

    const record =
      parsed.version === undefined ? chain.at(-1)! : chain.find((r) => r.version === parsed.version)
    if (!record) throw new NotFoundError(uri)

    // Defence in depth: the scheme is derived from the record, so even a URI
    // crafted with the wrong scheme cannot reach content of the other audience.
    if (!principal.scopes.includes(SCOPE[record.audience])) throw new NotFoundError(uri)

    return record
  }

  versions(patient: string, domain: string): CareRecord[] {
    return this.#chains.get(this.#key(patient, domain)) ?? []
  }

  /** Age of the latest version, and whether it is past its stale_after. */
  staleness(uri: string, principal: Principal, now = new Date()) {
    const r = this.read(uri, principal)
    const ageMs = now.getTime() - new Date(r.writtenAt).getTime()
    const stale = r.staleAfter ? now.getTime() > new Date(r.staleAfter).getTime() : false
    return { ageMs, stale, lastModified: r.writtenAt, versionHash: r.versionHash, staleAfter: r.staleAfter }
  }

  /** Replay the chain. Any tampered value breaks the hash and is located exactly. */
  verify(patient: string, domain: string): ChainVerdict {
    const chain = this.versions(patient, domain)
    const uri = chain.length ? uriFor(patient, domain, chain[0]!.audience) : `${patient}/${domain}`
    let prev: string | null = null
    for (const r of chain) {
      const expected = hashVersion(prev, r.value, r.writtenAt, r.authorId)
      if (expected !== r.versionHash) {
        return { uri, versions: chain.length, intact: false, brokenAt: r.version, expected, actual: r.versionHash }
      }
      prev = r.versionHash
    }
    return { uri, versions: chain.length, intact: true }
  }

  annotationsFor(r: CareRecord): Annotations {
    return { audience: [r.audience], priority: r.priority, lastModified: r.writtenAt }
  }

  /** Test seam only — lets a test corrupt a stored value to prove verify() catches it. */
  _tamper(patient: string, domain: string, version: number, newValue: string) {
    const chain = this.#chains.get(this.#key(patient, domain))
    const rec = chain?.find((r) => r.version === version)
    if (rec) rec.value = newValue
  }
}

export function parseUri(
  uri: string,
): { patient: string; domain: string; audience: Audience; version?: number } | null {
  for (const audience of ['user', 'assistant'] as const) {
    const prefix = SCHEME[audience]
    if (!uri.startsWith(prefix)) continue
    const rest = uri.slice(prefix.length)
    const parts = rest.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const [patient, domain, versionPart] = parts
    let version: number | undefined
    if (versionPart) {
      const m = /^v(\d+)$/.exec(versionPart)
      if (!m) return null
      version = Number(m[1])
    }
    return { patient: patient!, domain: domain!, audience, version }
  }
  return null
}
