import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DecryptionFailedError,
  Envelope,
  EnvelopeError,
  EnvelopeKeyMismatchError,
  KmsKeyProvider,
  KmsUnavailableError,
  LocalKeyProvider,
  MasterKeyMissingError,
  describeSealed,
  envelopeFromEnv,
  recordAad,
  startupLine,
} from '../src/envelope.ts'
import { LiveResourceStore, uriFor } from '../src/store.ts'
import { DEMO_NOW, RAY, STAGED_REVISION, seed } from '../src/seed.ts'

const MASTER = 'a'.repeat(64) // 32 bytes of hex — a fixed key, so failures are reproducible
const OTHER_MASTER = 'b'.repeat(64)

const local = (master = MASTER) => new LocalKeyProvider(Buffer.from(master, 'hex'))
const envelope = (master = MASTER) => Envelope.create(local(master), { announce: false })

const RISK = { patient: RAY, domain: 'risk', version: 1, audience: 'assistant' as const }
const WEIGHT = { patient: RAY, domain: 'weight_bearing', version: 1, audience: 'user' as const }

const SECRET = 'Fall risk HIGH. Family disputes the discharge plan.'

const userOnly = { sub: 'host', scopes: ['care.read.user'] }
const both = { sub: 'reasoner', scopes: ['care.read.user', 'care.read.assistant'] }

/** Flip the lowest bit of one byte. Enough to break GCM; small enough to be a real threat. */
function flip(buf: Buffer, index: number): Buffer {
  const copy = Buffer.from(buf)
  copy[index] = copy[index]! ^ 0x01
  return copy
}

// ── the AAD binding: this is the whole point of encrypting at all ─────────────

describe('AAD binding — a ciphertext only opens in the slot it was sealed in', () => {
  it('round-trips under its own identity', async () => {
    const e = await envelope()
    expect(e.decrypt(e.encrypt(SECRET, recordAad(RISK)), recordAad(RISK))).toBe(SECRET)
  })

  it('REFUSES a ciphertext pasted into another record', async () => {
    // The attack this exists to stop: an attacker with write access to storage moves
    // the assistant-only bytes into a care:// record and has them read aloud to Ray.
    const e = await envelope()
    const sealed = e.encrypt(SECRET, recordAad(RISK))
    expect(() => e.decrypt(sealed, recordAad(WEIGHT))).toThrow(DecryptionFailedError)
  })

  it('REFUSES the same record under a different audience', async () => {
    const e = await envelope()
    const sealed = e.encrypt(SECRET, recordAad(RISK))
    expect(() => e.decrypt(sealed, recordAad({ ...RISK, audience: 'user' }))).toThrow(
      DecryptionFailedError,
    )
  })

  it('REFUSES a ciphertext replayed onto a different version of the same record', async () => {
    // Rolling a patient back to a superseded instruction is a clinical attack, not
    // just a storage one: v1 said partial weight-bearing, v2 said full.
    const e = await envelope()
    const sealed = e.encrypt(SECRET, recordAad(WEIGHT))
    expect(() => e.decrypt(sealed, recordAad({ ...WEIGHT, version: 2 }))).toThrow(
      DecryptionFailedError,
    )
  })

  it('names the identity it failed under, so the paste is diagnosable', async () => {
    const e = await envelope()
    const sealed = e.encrypt(SECRET, recordAad(RISK))
    expect(() => e.decrypt(sealed, recordAad(WEIGHT))).toThrow(/ray\|weight_bearing\|v1\|user/)
  })

  it('reserves the separator rather than letting two identities collide', () => {
    expect(() => recordAad({ ...RISK, domain: 'risk|user' })).toThrow(EnvelopeError)
  })
})

// ── integrity: GCM must catch every single-bit edit ──────────────────────────

describe('integrity — a flipped bit anywhere fails to authenticate', () => {
  it('REFUSES a flipped bit in the ciphertext', async () => {
    const e = await envelope()
    const sealed = e.encrypt(SECRET, recordAad(RISK))
    expect(() => e.decrypt(flip(sealed, sealed.length - 1), recordAad(RISK))).toThrow(
      DecryptionFailedError,
    )
  })

  it('REFUSES a flipped bit in the auth tag', async () => {
    const e = await envelope()
    const sealed = e.encrypt(SECRET, recordAad(RISK))
    const tagStart = sealed.length - describeSealed(sealed).ciphertextBytes - 16
    expect(() => e.decrypt(flip(sealed, tagStart), recordAad(RISK))).toThrow(DecryptionFailedError)
  })

  it('REFUSES a flipped bit in the IV', async () => {
    const e = await envelope()
    const sealed = e.encrypt(SECRET, recordAad(RISK))
    const ivStart = sealed.length - describeSealed(sealed).ciphertextBytes - 16 - 12
    expect(() => e.decrypt(flip(sealed, ivStart), recordAad(RISK))).toThrow(DecryptionFailedError)
  })

  it('REFUSES truncated bytes with a typed error, not a RangeError', async () => {
    const e = await envelope()
    const sealed = e.encrypt(SECRET, recordAad(RISK))
    expect(() => e.decrypt(sealed.subarray(0, 20), recordAad(RISK))).toThrow(DecryptionFailedError)
  })

  it('REFUSES bytes that are not an envelope at all', async () => {
    const e = await envelope()
    expect(() => e.open('not an envelope, just a string', recordAad(RISK))).toThrow(
      DecryptionFailedError,
    )
  })
})

describe('nonce discipline', () => {
  it('produces different bytes for the same plaintext each time', async () => {
    const e = await envelope()
    const a = e.encrypt(SECRET, recordAad(RISK))
    const b = e.encrypt(SECRET, recordAad(RISK))
    expect(a.equals(b)).toBe(false)
    expect(describeSealed(a).ivHex).not.toBe(describeSealed(b).ivHex)
    // Both must still open — a random IV is not an excuse for a flaky round trip.
    expect(e.decrypt(a, recordAad(RISK))).toBe(e.decrypt(b, recordAad(RISK)))
  })

  it('uses a 96-bit IV and a 128-bit tag', async () => {
    const e = await envelope()
    const d = describeSealed(e.encrypt(SECRET, recordAad(RISK)))
    expect(d.ivHex).toHaveLength(24)
    expect(d.tagHex).toHaveLength(32)
  })
})

describe('envelope header is self-describing without the key', () => {
  it('names the provider, key and algorithm to a reader holding no key', async () => {
    const e = await envelope()
    const d = describeSealed(e.encrypt(SECRET, recordAad(RISK)))
    expect(d).toMatchObject({ format: 1, algorithm: 'AES-256-GCM', provider: 'local-hkdf' })
    expect(d.keyId).toBe('unsay/local/v1')
    expect(d.ciphertextBytes).toBe(Buffer.byteLength(SECRET))
  })
})

// ── local provider: real HKDF, real key isolation ────────────────────────────

describe('LocalKeyProvider', () => {
  it('isolates keys — another master key cannot open these bytes', async () => {
    const mine = await envelope(MASTER)
    const theirs = await envelope(OTHER_MASTER)
    const sealed = mine.encrypt(SECRET, recordAad(RISK))
    // Same keyId and same salt length, so the mismatch is not detectable structurally.
    await expect(theirs.openAsync(sealed, recordAad(RISK))).rejects.toThrow(DecryptionFailedError)
  })

  it('re-derives an older data key through the provider (the rotation path)', async () => {
    const provider = local()
    const first = await Envelope.create(provider, { announce: false })
    const second = await Envelope.create(provider, { announce: false })
    const sealed = first.encrypt(SECRET, recordAad(RISK))
    // The sync path holds exactly one data key and says so rather than failing vaguely.
    expect(() => second.decrypt(sealed, recordAad(RISK))).toThrow(EnvelopeKeyMismatchError)
    expect(await second.openAsync(sealed, recordAad(RISK))).toBe(SECRET)
  })

  it('demands a master key rather than inventing one', () => {
    expect(() => LocalKeyProvider.fromEnv({})).toThrow(MasterKeyMissingError)
    expect(() => LocalKeyProvider.fromEnv({})).toThrow(/openssl rand -hex 32/)
  })

  it('rejects a master key with too little entropy', () => {
    expect(() => LocalKeyProvider.fromEnv({ UNSAY_MASTER_KEY: 'hunter2' })).toThrow(
      MasterKeyMissingError,
    )
  })

  it('marks an ephemeral key as ephemeral, so a demo cannot look durable', () => {
    expect(LocalKeyProvider.ephemeral().describe()).toBe('local-hkdf(ephemeral)')
  })
})

// ── KMS provider: honest adapter, never a silent downgrade ───────────────────

describe('KmsKeyProvider — refuses rather than degrades', () => {
  it('throws a typed, actionable error when nothing is configured', async () => {
    await expect(KmsKeyProvider.fromEnv({}).dataKey()).rejects.toThrow(KmsUnavailableError)
  })

  it('names every missing variable and both remedies', async () => {
    const err = await KmsKeyProvider.fromEnv({})
      .dataKey()
      .catch((e: Error) => e)
    const msg = (err as Error).message
    for (const v of ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'UNSAY_KMS_KEY_ID']) {
      expect(msg).toContain(v)
    }
    expect(msg).toContain('UNSAY_KEY_PROVIDER=local')
    expect(msg).toContain('does not fall back to local')
  })

  it('names ONLY what is missing when partially configured', async () => {
    const p = KmsKeyProvider.fromEnv({ AWS_REGION: 'us-east-1', UNSAY_KMS_KEY_ID: 'alias/unsay' })
    const msg = await p.dataKey().catch((e: Error) => e.message)
    expect(msg).toContain('AWS_ACCESS_KEY_ID')
    expect(msg).not.toContain('AWS_REGION')
  })

  it('does NOT start an envelope on an unconfigured KMS provider', async () => {
    // The failure mode this blocks: a server that boots, prints "at-rest: KMS", and
    // is in fact holding plaintext. Refusing to start is the only honest option.
    await expect(Envelope.create(KmsKeyProvider.fromEnv({}), { announce: false })).rejects.toThrow(
      KmsUnavailableError,
    )
  })

  it('signs a real SigV4 GenerateDataKey request', async () => {
    // Asserts the bytes we would put on the wire. The AWS account is under the hold in
    // FRICTION.md F-004, so this path is signed and shaped but not yet exercised
    // against live KMS — stated in FRICTION.md rather than papered over.
    let seen: { url: string; init: RequestInit } | null = null
    const plaintextKey = randomBytes(32)
    const p = new KmsKeyProvider({
      region: 'us-east-1',
      keyId: 'alias/unsay',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init }
        return new Response(
          JSON.stringify({
            Plaintext: plaintextKey.toString('base64'),
            CiphertextBlob: Buffer.from('wrapped').toString('base64'),
            KeyId: 'arn:aws:kms:us-east-1:1:key/abc',
          }),
          { status: 200 },
        )
      }) as unknown as typeof fetch,
    })

    const dk = await p.dataKey()
    expect(dk.plaintextKey.equals(plaintextKey)).toBe(true)
    expect(dk.keyId).toBe('arn:aws:kms:us-east-1:1:key/abc')

    const req = seen! as { url: string; init: RequestInit }
    expect(req.url).toBe('https://kms.us-east-1.amazonaws.com/')
    const headers = req.init.headers as Record<string, string>
    expect(headers['x-amz-target']).toBe('TrentService.GenerateDataKey')
    expect(headers['content-type']).toBe('application/x-amz-json-1.1')
    expect(JSON.parse(req.init.body as string)).toEqual({ KeyId: 'alias/unsay', KeySpec: 'AES_256' })
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/kms\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    )
    // `host` is signed but cannot be set on a fetch request; it must not be sent.
    expect(headers.host).toBeUndefined()
  })

  it('surfaces an AWS error instead of falling back to a local key', async () => {
    const p = new KmsKeyProvider({
      region: 'us-east-1',
      keyId: 'alias/unsay',
      accessKeyId: 'AKIA',
      secretAccessKey: 'x',
      fetch: (async () =>
        new Response('{"__type":"AccessDeniedException"}', { status: 400 })) as unknown as typeof fetch,
    })
    await expect(p.dataKey()).rejects.toThrow(/AccessDeniedException/)
  })
})

// ── provider selection and the startup line ──────────────────────────────────

describe('provider selection is explicit in both directions', () => {
  it('returns null and SAYS plaintext when nothing is configured', async () => {
    expect(await envelopeFromEnv({})).toBeNull()
    expect(startupLine(null)).toContain('PLAINTEXT')
  })

  it('names the provider and key in the startup line', async () => {
    const e = await envelopeFromEnv({ UNSAY_KEY_PROVIDER: 'local', UNSAY_MASTER_KEY: MASTER })
    const line = startupLine(e)
    expect(line).toContain('AES-256-GCM')
    expect(line).toContain('local-hkdf')
    expect(line).toContain('unsay/local/v1')
    expect(line).toContain('AAD=patient|domain|version|audience')
  })

  it('fails closed when KMS is selected but unconfigured', async () => {
    await expect(envelopeFromEnv({ UNSAY_KEY_PROVIDER: 'kms' })).rejects.toThrow(KmsUnavailableError)
  })

  it('rejects an unrecognised provider rather than guessing', async () => {
    await expect(envelopeFromEnv({ UNSAY_KEY_PROVIDER: 'aes' })).rejects.toThrow(EnvelopeError)
  })
})

// ── the store, with encryption on ────────────────────────────────────────────

const sealedStore = async () => seed(new LiveResourceStore({ envelope: await envelope() }))

describe('LiveResourceStore with an envelope', () => {
  it('holds no plaintext at rest, for any seeded record', async () => {
    const plain = seed(new LiveResourceStore())
    const s = await sealedStore()
    for (const { record } of plain.list(both)) {
      const stored = s.atRest(record.patient, record.domain, record.version)
      expect(stored).not.toContain(record.value)
      // and not merely base64-hidden: the decoded bytes must not carry it either
      expect(Buffer.from(stored, 'base64').includes(record.value)).toBe(false)
    }
  })

  it('leaks nothing from the never-speakable record', async () => {
    const s = await sealedStore()
    const stored = Buffer.from(s.atRest(RAY, 'risk'), 'base64').toString('latin1')
    for (const word of ['Fall risk', 'disputes', 'Lives alone', 'premature']) {
      expect(stored).not.toContain(word)
    }
  })

  it('round-trips publish → read to the exact plaintext', async () => {
    const s = await sealedStore()
    const published = s.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    expect(published.value).toBe(STAGED_REVISION.value)
    expect(s.read(uriFor(RAY, 'weight_bearing', 'user'), userOnly).value).toBe(STAGED_REVISION.value)
    expect(s.read(uriFor(RAY, 'weight_bearing', 'user', 2), userOnly).value).toContain('Partial')
  })

  it('keeps the version chain intact through encryption', async () => {
    const s = await sealedStore()
    s.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    expect(s.verify(RAY, 'weight_bearing').intact).toBe(true)
    expect(s.verify(RAY, 'risk').intact).toBe(true)
  })

  it('hashes the PLAINTEXT, so the chain is identical encrypted or not', async () => {
    // If the chain hashed ciphertext it would change on every re-seal, and an auditor
    // holding only the audit log — who has no key — could not replay it at all.
    const plain = seed(new LiveResourceStore())
    const s = await sealedStore()
    expect(s.versions(RAY, 'weight_bearing')[0]!.versionHash).toBe(
      plain.versions(RAY, 'weight_bearing')[0]!.versionHash,
    )
  })

  it('serves plaintext through list() and versions()', async () => {
    const s = await sealedStore()
    expect(s.list(both).map((x) => x.record.value)).toContain(
      'Ward 4 physio line, weekdays nine to five. Out of hours, call 111.',
    )
    expect(s.versions(RAY, 'risk')[0]!.value).toContain('Fall risk')
  })

  it('still hides assistant-only records from a user-scoped principal', async () => {
    const s = await sealedStore()
    expect(() => s.read(uriFor(RAY, 'risk', 'assistant'), userOnly)).toThrow(/not found/i)
    expect(s.list(userOnly)).toHaveLength(5)
  })

  it('DEFEATS a cross-record paste in storage itself', async () => {
    // The attacker owns the database and moves the never-speakable bytes into the
    // record Alexa reads aloud. Scope checks cannot see this; the AAD does.
    const s = await sealedStore()
    s._tamper(RAY, 'weight_bearing', 1, s.atRest(RAY, 'risk', 1))
    expect(() => s.read(uriFor(RAY, 'weight_bearing', 'user', 1), userOnly)).toThrow(
      DecryptionFailedError,
    )
    const v = s.verify(RAY, 'weight_bearing')
    expect(v.intact).toBe(false)
    expect(v.brokenAt).toBe(1)
    expect(v.expected).toBe('<undecryptable at rest>')
  })

  it('catches a flipped bit in stored ciphertext at verify time', async () => {
    const s = await sealedStore()
    const stored = Buffer.from(s.atRest(RAY, 'exercise', 1), 'base64')
    s._tamper(RAY, 'exercise', 1, flip(stored, stored.length - 1).toString('base64'))
    expect(s.verify(RAY, 'exercise').intact).toBe(false)
  })

  it('issues a receipt naming the provider actually used', async () => {
    const s = await sealedStore()
    const r = s.atRestReceipt(RAY, 'risk', 1)
    expect(r).toMatchObject({
      uri: 'care-internal://ray/risk/v1',
      encrypted: true,
      algorithm: 'AES-256-GCM',
      provider: 'local-hkdf',
      keyId: 'unsay/local/v1',
      aad: 'ray|risk|v1|assistant',
    })
    expect(r.versionHash).toBe(s.versions(RAY, 'risk')[0]!.versionHash)
  })

  it('reports unreadable storage in the receipt instead of throwing', async () => {
    const s = await sealedStore()
    s._tamper(RAY, 'contact', 1, 'garbage')
    expect(s.atRestReceipt(RAY, 'contact', 1).algorithm).toBe('unreadable')
  })
})
