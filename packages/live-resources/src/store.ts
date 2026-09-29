/**
 * LiveResourceStore — an in-memory, append-only store of versioned MCP resources.
 *
 * Four properties, and they only mean anything together:
 *
 *   1. Publishing a revision NOTIFIES. A host that has subscribed learns while it
 *      is still mid-answer, which is the only moment a correction is worth much.
 *   2. Every revision is CHAINED. Staleness and provenance are replayable rather
 *      than asserted.
 *   3. Every read is PARTITIONED by audience, server-side, by scope — see
 *      partition.ts for why the MCP annotation cannot carry that weight alone.
 *   4. Values may be SEALED at rest, bound to the slot they belong in, so the
 *      partition survives an attacker who owns the storage.
 *
 * In-memory on purpose: the notification path is the product, and a durable store
 * is a decision about someone else's infrastructure. Persistence goes behind the
 * store (rehydrate by replaying `publish`) or beside it (mirror `onUpdated`).
 */
import { hashVersion, recordAad } from './chain.ts'
import type { RecordIdentity } from './chain.ts'
import type { SealedDescription, ValueCodec } from './codec.ts'
import { LiveResourceError, NotFoundError } from './errors.ts'
import { AudiencePartition, DEFAULT_PARTITION } from './partition.ts'
import type {
  Annotations,
  AtRestReceipt,
  ChainVerdict,
  ListChangedListener,
  LiveRecord,
  Principal,
  PublishInput,
  Staleness,
  Unsubscribe,
  UpdatedListener,
} from './types.ts'

export interface StoreOptions {
  /** URI schemes and scopes per audience. Defaults to `live://` / `live-internal://`. */
  partition?: AudiencePartition
  /**
   * When supplied, values are sealed at rest with the record's identity as AAD.
   * Omitted, the store holds plaintext and `atRestReceipt()` says so out loud.
   */
  codec?: ValueCodec | null
  /**
   * Called when a listener throws. One failing listener must not stop the rest from
   * hearing a revision — each listener is another session's retraction. Default:
   * console.error.
   */
  onListenerError?: (error: unknown, uri: string | null) => void
}

/** One entry of `list()`: the record, and the URI the caller should ask for it by. */
export interface ListedRecord {
  record: LiveRecord
  uri: string
}

export class LiveResourceStore {
  /** key = `${subject}/${topic}` -> versions, oldest first. Values are AT-REST form. */
  #chains = new Map<string, LiveRecord[]>()
  #updated: UpdatedListener[] = []
  #listChanged: ListChangedListener[] = []
  #partition: AudiencePartition
  #codec: ValueCodec | null
  #onListenerError: (error: unknown, uri: string | null) => void

  constructor(opts: StoreOptions = {}) {
    this.#partition = opts.partition ?? DEFAULT_PARTITION
    this.#codec = opts.codec ?? null
    this.#onListenerError =
      opts.onListenerError ?? ((e, uri) => console.error('[live-resources] listener failed for', uri, e))
  }

  get partition(): AudiencePartition {
    return this.#partition
  }

  /**
   * The codec this store actually holds, or null for plaintext. Exposed so a banner
   * describes the STORE rather than the configuration that was meant to build it —
   * a server handed a pre-sealed store would otherwise announce "PLAINTEXT" while
   * serving ciphertext, which is a lie in the safer direction and still a lie.
   */
  get codec(): ValueCodec | null {
    return this.#codec
  }

  /** Convenience so callers holding a store need not also carry the partition. */
  uriFor(subject: string, topic: string, audience: LiveRecord['audience'], version?: number): string {
    return this.#partition.uriFor(subject, topic, audience, version)
  }

  /** Fires on every revision AFTER the first, with the unversioned URI. */
  onUpdated(fn: UpdatedListener): Unsubscribe {
    this.#updated.push(fn)
    return () => {
      this.#updated = this.#updated.filter((f) => f !== fn)
    }
  }

  /** Fires when a chain appears that did not exist before — a change to the LIST. */
  onListChanged(fn: ListChangedListener): Unsubscribe {
    this.#listChanged.push(fn)
    return () => {
      this.#listChanged = this.#listChanged.filter((f) => f !== fn)
    }
  }

  #key(subject: string, topic: string) {
    return `${subject}/${topic}`
  }

  /** Identity -> AAD. Sealing and opening MUST agree on this or nothing decrypts. */
  #seal(value: string, id: RecordIdentity): string {
    if (!this.#codec) return value
    return this.#codec.seal(value, recordAad(id))
  }

  /**
   * A copy carrying the plaintext value. Every accessor that hands out a record uses
   * it — including the plaintext store, which used to hand out the stored object
   * itself: a caller that set `.audience = 'user'` on a read result moved a
   * reasoning-only fact into the speakable lane, and verify() still said intact.
   */
  #open(r: LiveRecord): LiveRecord {
    return this.#codec ? { ...r, value: this.#codec.open(r.value, recordAad(r)) } : { ...r }
  }

  /** The raw chain, at-rest values intact. Only verify() and the receipts see this. */
  #raw(subject: string, topic: string): LiveRecord[] {
    return this.#chains.get(this.#key(subject, topic)) ?? []
  }

  /**
   * Append a revision.
   *
   * Fires `updated` for every version after the first, and `listChanged` for the
   * first — a resource that did not exist is a change to the list, not to a
   * resource, and a host that conflates them re-reads a URI it has never seen.
   */
  publish(input: PublishInput): LiveRecord {
    const key = this.#key(input.subject, input.topic)
    const chain = this.#chains.get(key) ?? []
    const prev = chain.at(-1) ?? null

    if (prev && prev.audience !== input.audience) {
      // An audience flip would silently move an existing fact across the safety
      // boundary — subscribers keep the old URI and would be served the new value.
      throw new LiveResourceError(
        `refusing to change audience of ${key} from "${prev.audience}" to "${input.audience}"`,
      )
    }

    const identity = {
      subject: input.subject,
      topic: input.topic,
      version: (prev?.version ?? 0) + 1,
      audience: input.audience,
      authorId: input.authorId,
      authorLabel: input.authorLabel,
      writtenAt: input.writtenAt,
      staleAfter: input.staleAfter,
      priority: input.priority ?? 0.5,
    }

    const record: LiveRecord = Object.freeze({
      ...identity,
      value: this.#seal(input.value, identity),
      prevHash: prev?.versionHash ?? null,
      // The chain hashes the PLAINTEXT, always. Sealed bytes carry a random IV, so
      // hashing them would change on every re-seal and prove nothing about what the
      // author wrote — the chain is a provenance claim about the value, not about
      // the storage layer. It also keeps verify() meaningful for an auditor holding
      // the log and no key.
      versionHash: hashVersion(
        prev?.versionHash ?? null,
        input.value,
        input.writtenAt,
        input.authorId,
      ),
    })

    this.#chains.set(key, [...chain, record])

    if (prev) {
      const uri = this.#partition.uriFor(input.subject, input.topic, input.audience)
      for (const fn of this.#updated) {
        try {
          fn(uri)
        } catch (e) {
          this.#onListenerError(e, uri)
        }
      }
    } else {
      for (const fn of this.#listChanged) {
        try {
          fn()
        } catch (e) {
          this.#onListenerError(e, null)
        }
      }
    }
    // Opened, not `input.value`: a publish that cannot be read back is silent data
    // loss, and this surfaces it at the write instead of at the read.
    return this.#open(record)
  }

  /** Every URI this principal is allowed to know EXISTS, newest revision of each. */
  list(principal: Principal): ListedRecord[] {
    const out: ListedRecord[] = []
    for (const chain of this.#chains.values()) {
      const latest = chain.at(-1)!
      if (!principal.scopes.includes(this.#partition.scopeFor(latest.audience))) continue
      out.push({
        record: this.#open(latest),
        uri: this.#partition.uriFor(latest.subject, latest.topic, latest.audience),
      })
    }
    return out
  }

  /**
   * Read by URI. THE enforcement point.
   *
   * A principal without the scope for this URI's scheme gets NotFoundError — not
   * "forbidden", which would confirm the record exists.
   */
  read(uri: string, principal: Principal): LiveRecord {
    const parsed = this.#partition.parseUri(uri)
    if (!parsed) throw new NotFoundError(uri)

    if (!principal.scopes.includes(this.#partition.scopeFor(parsed.audience))) {
      throw new NotFoundError(uri)
    }

    const chain = this.#chains.get(this.#key(parsed.subject, parsed.topic))
    if (!chain?.length) throw new NotFoundError(uri)

    const record =
      parsed.version === undefined ? chain.at(-1)! : chain.find((r) => r.version === parsed.version)
    if (!record) throw new NotFoundError(uri)

    // Defence in depth: the audience is re-read from the RECORD, so a URI crafted
    // with the wrong scheme cannot reach content of the other lane even if the two
    // schemes were ever made to overlap.
    if (!principal.scopes.includes(this.#partition.scopeFor(record.audience))) {
      throw new NotFoundError(uri)
    }

    return this.#open(record)
  }

  /** The whole chain, oldest first. Unauthorized — callers gate it with read(). */
  versions(subject: string, topic: string): LiveRecord[] {
    return this.#raw(subject, topic).map((r) => this.#open(r))
  }

  /** Age of the newest revision, and whether it has outlived its own `staleAfter`. */
  staleness(uri: string, principal: Principal, now = new Date()): Staleness {
    const r = this.read(uri, principal)
    return {
      ageMs: now.getTime() - new Date(r.writtenAt).getTime(),
      stale: r.staleAfter ? now.getTime() > new Date(r.staleAfter).getTime() : false,
      lastModified: r.writtenAt,
      versionHash: r.versionHash,
      staleAfter: r.staleAfter,
    }
  }

  /** Replay a chain. A tampered value breaks the hash and is located exactly. */
  verify(subject: string, topic: string): ChainVerdict {
    const chain = this.#raw(subject, topic)
    const first = chain[0]
    const uri = first
      ? this.#partition.uriFor(subject, topic, first.audience)
      : `${subject}/${topic}`
    let prev: string | null = null
    for (const r of chain) {
      let value: string
      try {
        value = this.#open(r).value
      } catch {
        // With a codec, at-rest tampering is caught by authentication before the
        // hash chain is consulted at all. Report it at the coordinates a hash break
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
        return {
          uri,
          versions: chain.length,
          intact: false,
          brokenAt: r.version,
          expected,
          actual: r.versionHash,
        }
      }
      prev = r.versionHash
    }
    return { uri, versions: chain.length, intact: true }
  }

  /** The MCP annotations for a record: audience, priority, lastModified. */
  annotationsFor(r: LiveRecord): Annotations {
    return { audience: [r.audience], priority: r.priority, lastModified: r.writtenAt }
  }

  #locate(subject: string, topic: string, version?: number): LiveRecord {
    const chain = this.#raw(subject, topic)
    const rec = version === undefined ? chain.at(-1) : chain.find((r) => r.version === version)
    if (!rec) {
      throw new NotFoundError(
        this.#partition.uriFor(subject, topic, chain[0]?.audience ?? 'user', version),
      )
    }
    return rec
  }

  /**
   * The stored form of a value — sealed bytes with a codec, plaintext without.
   * Public because "is this actually encrypted?" is a question a test and an
   * auditor both get to answer by looking, rather than by trusting.
   */
  atRest(subject: string, topic: string, version?: number): string {
    return this.#locate(subject, topic, version).value
  }

  /** What the stored bytes say about themselves. Never needs the key. */
  atRestReceipt(subject: string, topic: string, version?: number): AtRestReceipt {
    const rec = this.#locate(subject, topic, version)
    const base: AtRestReceipt = {
      uri: this.#partition.uriFor(subject, topic, rec.audience, rec.version),
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
    if (!this.#codec) return base

    // `undefined` = this codec cannot describe its own output, so the receipt
    // carries its name and nothing more. `null` = it looked and did not recognise
    // these bytes, which is a storage-corruption report, not an encryption claim —
    // a receipt on corrupted storage is exactly when someone needs to read one.
    const sealed: SealedDescription | null | undefined = this.#codec.describe?.(rec.value)
    if (sealed === null) return { ...base, algorithm: 'unreadable' }

    return {
      ...base,
      encrypted: true,
      algorithm: sealed?.algorithm ?? this.#codec.name,
      provider: sealed?.provider ?? null,
      keyId: sealed?.keyId ?? null,
      aad: recordAad(rec),
      ivHex: sealed?.ivHex ?? null,
      tagHex: sealed?.tagHex ?? null,
      ciphertextBytes: sealed?.ciphertextBytes ?? null,
    }
  }

  /**
   * Test seam. Corrupts a stored value in place so a test can prove verify()
   * catches it — the only way to demonstrate a tamper-evident chain is to tamper.
   */
  _tamper(subject: string, topic: string, version: number, newValue: string) {
    // Records are frozen; the only way to change one is to replace it, here.
    const chain = this.#chains.get(this.#key(subject, topic))
    const i = chain?.findIndex((r) => r.version === version) ?? -1
    if (chain && i >= 0) chain[i] = Object.freeze({ ...chain[i]!, value: newValue })
  }
}
