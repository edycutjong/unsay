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
import { type Envelope, type RecordIdentity, describeSealed, recordAad } from './envelope.ts'
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

/** Fixed shape whether or not an envelope is configured — a receipt must be diffable. */
export interface AtRestReceipt {
  uri: string
  versionHash: string
  encrypted: boolean
  algorithm: string
  provider: string | null
  keyId: string | null
  aad: string | null
  ivHex: string | null
  tagHex: string | null
  ciphertextBytes: number | null
}

export type UpdatedListener = (uri: string) => void
export type ListChangedListener = () => void

export interface StoreOptions {
  /**
   * When supplied, values are AES-256-GCM sealed at rest with the record's identity
   * as AAD (see envelope.ts). Omitted, the store behaves exactly as it did before
   * encryption existed — plaintext in memory, and `atRest()` admits it.
   */
  envelope?: Envelope
}

export class LiveResourceStore {
  /** key = `${patient}/${domain}` → versions, oldest first. Values are AT-REST form. */
  #chains = new Map<string, CareRecord[]>()
  #listeners: UpdatedListener[] = []
  #listChangedListeners: ListChangedListener[] = []
  #envelope: Envelope | null

  constructor(opts: StoreOptions = {}) {
    this.#envelope = opts.envelope ?? null
  }

  /**
   * The envelope this store actually holds, or null for plaintext. Exposed so a
   * banner or a receipt can describe the STORE rather than the configuration that
   * was meant to build it — a server handed a pre-sealed store would otherwise
   * announce "PLAINTEXT" while serving ciphertext, which is the wrong lie in the
   * safer direction and still a lie.
   */
  get envelope(): Envelope | null {
    return this.#envelope
  }

  onUpdated(fn: UpdatedListener) {
    this.#listeners.push(fn)
    return () => {
      this.#listeners = this.#listeners.filter((f) => f !== fn)
    }
  }

  /** Fires when a domain appears that did not exist before. */
  onListChanged(fn: ListChangedListener) {
    this.#listChangedListeners.push(fn)
    return () => {
      this.#listChangedListeners = this.#listChangedListeners.filter((f) => f !== fn)
    }
  }

  #key(patient: string, domain: string) {
    return `${patient}/${domain}`
  }

  /** Identity → AAD. Sealing and opening MUST agree on this or nothing decrypts. */
  #seal(value: string, id: RecordIdentity) {
    if (!this.#envelope) return value
    return this.#envelope.seal(value, recordAad(id))
  }

  /** A copy carrying the plaintext value. Every accessor that hands out a record uses it. */
  #open(r: CareRecord): CareRecord {
    if (!this.#envelope) return r
    return { ...r, value: this.#envelope.open(r.value, recordAad(r)) }
  }

  /** The raw chain, at-rest values intact. Only verify() and the test seams see this. */
  #raw(patient: string, domain: string): CareRecord[] {
    return this.#chains.get(this.#key(patient, domain)) ?? []
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

    const identity = {
      patient: input.patient,
      domain: input.domain,
      version: (prev?.version ?? 0) + 1,
      audience: input.audience,
      authorId: input.authorId,
      authorLabel: input.authorLabel,
      writtenAt: input.writtenAt,
      staleAfter: input.staleAfter,
      priority: input.priority ?? 0.5,
    }

    const record: CareRecord = {
      ...identity,
      value: this.#seal(input.value, identity),
      prevHash: prev?.versionHash ?? null,
      // The chain hashes the PLAINTEXT, always. Ciphertext carries a random IV, so
      // hashing it would change on every re-seal and prove nothing about what the
      // clinician wrote — the chain is a provenance claim about the instruction,
      // not about the storage layer. It also keeps verify() meaningful for a judge
      // holding only the audit log, who has no key.
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
    } else {
      // A domain that did not exist before changes the resource LIST, not a
      // resource. We declare capabilities.resources.listChanged, so we must send it.
      for (const fn of this.#listChangedListeners) fn()
    }
    // Opened, not `input.value`: a publish that cannot be read back is a silent
    // data-loss bug, and this makes it surface at the write, not at the demo.
    return this.#open(record)
  }

  /** Every URI a principal is ALLOWED to know exists. */
  list(principal: Principal): { record: CareRecord; uri: string }[] {
    const out: { record: CareRecord; uri: string }[] = []
    for (const chain of this.#chains.values()) {
      const latest = chain.at(-1)!
      if (!principal.scopes.includes(SCOPE[latest.audience])) continue
      out.push({ record: this.#open(latest), uri: uriFor(latest.patient, latest.domain, latest.audience) })
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

    return this.#open(record)
  }

  versions(patient: string, domain: string): CareRecord[] {
    const chain = this.#raw(patient, domain)
    return this.#envelope ? chain.map((r) => this.#open(r)) : chain
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
    const chain = this.#raw(patient, domain)
    const uri = chain.length ? uriFor(patient, domain, chain[0]!.audience) : `${patient}/${domain}`
    let prev: string | null = null
    for (const r of chain) {
      let value: string
      try {
        value = this.#open(r).value
      } catch {
        // With an envelope, at-rest tampering is caught by the GCM tag before the
        // hash chain is even consulted. Report it at the coordinates a hash break
        // would use, so callers have one failure shape to handle.
        return {
          uri,
          versions: chain.length,
          intact: false,
          brokenAt: r.version,
          expected: '<undecryptable at rest>',
          actual: r.versionHash,
        }
      }
      const expected = hashVersion(prev, value, r.writtenAt, r.authorId)
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

  #locate(patient: string, domain: string, version?: number): CareRecord {
    const chain = this.#raw(patient, domain)
    const rec = version === undefined ? chain.at(-1) : chain.find((r) => r.version === version)
    if (!rec) throw new NotFoundError(uriFor(patient, domain, chain[0]?.audience ?? 'user', version))
    return rec
  }

  /**
   * The stored form of a value — ciphertext when an envelope is configured, and the
   * plaintext when one is not. Public because "is this actually encrypted?" is a
   * question a test and a judge both get to answer by looking, not by trusting.
   */
  atRest(patient: string, domain: string, version?: number): string {
    return this.#locate(patient, domain, version).value
  }

  /**
   * What the stored bytes say about themselves — provider, key, IV, tag, size. Every
   * field is read from the envelope header WITHOUT the data key, so this is a receipt
   * an auditor can take rather than a claim the server makes about itself.
   */
  atRestReceipt(patient: string, domain: string, version?: number): AtRestReceipt {
    const rec = this.#locate(patient, domain, version)
    const base: AtRestReceipt = {
      uri: uriFor(patient, domain, rec.audience, rec.version),
      versionHash: rec.versionHash,
      encrypted: false,
      algorithm: 'none',
      provider: null,
      keyId: null,
      aad: null,
      ivHex: null,
      tagHex: null,
      ciphertextBytes: null,
    }
    if (!this.#envelope) return base
    try {
      const d = describeSealed(Buffer.from(rec.value, 'base64'))
      return {
        ...base,
        encrypted: true,
        algorithm: d.algorithm,
        provider: d.provider,
        keyId: d.keyId,
        aad: recordAad(rec),
        ivHex: d.ivHex,
        tagHex: d.tagHex,
        ciphertextBytes: d.ciphertextBytes,
      }
    } catch {
      // Stored bytes that are not a well-formed envelope. Say so rather than throwing:
      // a receipt on corrupted storage is exactly when someone needs to read one.
      return { ...base, algorithm: 'unreadable' }
    }
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
