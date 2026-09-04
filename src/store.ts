/**
 * Unsay's store — the generic mechanism, bound to care:// URIs.
 *
 * The mechanism itself lives in `packages/live-resources` (`@unsay/live-resources`):
 * versioned records, revision notifications, the hash chain, and the audience/scope
 * partition. None of it knows about hips, physios, or Alexa, which is why it could
 * be lifted out — an MCP server publishing mutable state needs exactly this whether
 * the state is a care plan or a deployment.
 *
 * What stays here is the care-specific half, and only that:
 *   - the two schemes and two scopes the partition is configured with (types.ts),
 *   - `patient`/`domain` as the names for the record's two path segments,
 *   - the adapter from envelope.ts's KMS/local Envelope onto the package's codec seam.
 *
 * Imported by relative path, as a workspace package would be. It is NOT published
 * to npm and nothing here pretends it is.
 */
import { LiveResourceStore as GenericStore } from '../packages/live-resources/src/index.ts'
import { AudiencePartition, NotFoundError } from '../packages/live-resources/src/index.ts'
import type {
  ListedRecord,
  ParsedUri,
  SealedDescription,
  ValueCodec,
} from '../packages/live-resources/src/index.ts'
import { type Envelope, describeSealed } from './envelope.ts'
import { SCHEME, SCOPE, type Audience } from './types.ts'

export { NotFoundError }
export { hashVersion, recordAad } from '../packages/live-resources/src/index.ts'
export type { AtRestReceipt, PublishInput } from '../packages/live-resources/src/index.ts'

/**
 * The partition Unsay runs on: `care://` may be spoken, `care-internal://` may only
 * be reasoned over, and the scope for one never opens the other. Built from the
 * constants in types.ts so the scheme a URI carries and the scope the server checks
 * cannot drift apart.
 */
export const CARE_PARTITION = new AudiencePartition({
  user: { scheme: SCHEME.user, scope: SCOPE.user },
  assistant: { scheme: SCHEME.assistant, scope: SCOPE.assistant },
})

export function uriFor(patient: string, domain: string, audience: Audience, version?: number) {
  return CARE_PARTITION.uriFor(patient, domain, audience, version)
}

/** `{ patient, domain }` are the package's `{ subject, topic }` under care names. */
export function parseUri(uri: string): ParsedUri | null {
  return CARE_PARTITION.parseUri(uri)
}

export interface StoreOptions {
  /**
   * When supplied, values are AES-256-GCM sealed at rest with the record's identity
   * as AAD (see envelope.ts). Omitted, the store behaves exactly as it did before
   * encryption existed — plaintext in memory, and `atRest()` admits it.
   */
  envelope?: Envelope
}

/**
 * The Envelope, expressed as the package's codec seam. Two methods and a header
 * reader — the package never learns what KMS is, and envelope.ts never learns what
 * a record is beyond the AAD string it is handed.
 */
function codecFor(envelope: Envelope): ValueCodec {
  return {
    name: envelope.describe(),
    seal: (plaintext, aad) => envelope.seal(plaintext, aad),
    open: (sealed, aad) => envelope.open(sealed, aad),
    describe(sealed): SealedDescription | null {
      try {
        const d = describeSealed(Buffer.from(sealed, 'base64'))
        return {
          algorithm: d.algorithm,
          provider: d.provider,
          keyId: d.keyId,
          ivHex: d.ivHex,
          tagHex: d.tagHex,
          ciphertextBytes: d.ciphertextBytes,
        }
      } catch {
        // Stored bytes that are not a well-formed envelope. `null` tells the store
        // to receipt them as unreadable rather than claim they are encrypted.
        return null
      }
    },
  }
}

export class LiveResourceStore extends GenericStore {
  #envelope: Envelope | null

  constructor(opts: StoreOptions = {}) {
    const envelope = opts.envelope ?? null
    super({
      partition: CARE_PARTITION,
      codec: envelope ? codecFor(envelope) : null,
    })
    this.#envelope = envelope
  }

  /**
   * The envelope this store actually holds, or null for plaintext. Exposed so the
   * startup banner describes the STORE rather than the configuration that was meant
   * to build it — a server handed a pre-sealed store would otherwise announce
   * "PLAINTEXT" while serving ciphertext, which is the wrong lie in the safer
   * direction and still a lie.
   */
  get envelope(): Envelope | null {
    return this.#envelope
  }
}

export type { ListedRecord }
