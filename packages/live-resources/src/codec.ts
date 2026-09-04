/**
 * At-rest codec — the seam where encryption plugs in, and the reason this package
 * has no crypto dependency of its own.
 *
 * The store never chooses an algorithm, a key, or a provider. It decides only WHAT
 * the bytes are bound to (see `recordAad`) and hands that string to whatever codec
 * it was constructed with. A server that needs KMS, or a local key, or nothing at
 * all, supplies it here; the store's guarantees are identical either way.
 */

/**
 * Header facts about stored bytes, readable WITHOUT the key. This is what makes an
 * at-rest receipt a receipt rather than a claim: an auditor reads the provider, key
 * id and sizes off the bytes themselves instead of believing the server's banner.
 */
export interface SealedDescription {
  algorithm: string
  provider: string | null
  keyId: string | null
  ivHex: string | null
  tagHex: string | null
  ciphertextBytes: number | null
}

export interface ValueCodec {
  /** Short machine tag for logs and receipts, e.g. `aes-256-gcm/local`. */
  readonly name: string
  /** Plaintext + AAD -> the string that is actually stored. */
  seal(plaintext: string, aad: string): string
  /** The inverse. MUST throw if the AAD does not match the one used to seal. */
  open(sealed: string, aad: string): string
  /** Optional. Omit it and receipts report the codec name and nothing more. */
  describe?(sealed: string): SealedDescription | null
}
