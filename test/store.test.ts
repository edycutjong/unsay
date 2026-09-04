import { describe, expect, it } from 'vitest'
import { LiveResourceStore, NotFoundError, hashVersion, parseUri, uriFor } from '../src/store.ts'
import { DEMO_NOW, RAY, STAGED_REVISION, seed } from '../src/seed.ts'

const userOnly = { sub: 'host', scopes: ['care.read.user'] }
const both = { sub: 'reasoner', scopes: ['care.read.user', 'care.read.assistant'] }
const fresh = () => seed(new LiveResourceStore())

describe('uri parsing', () => {
  it('maps scheme to audience', () => {
    expect(parseUri('care://ray/weight_bearing')?.audience).toBe('user')
    expect(parseUri('care-internal://ray/risk')?.audience).toBe('assistant')
  })
  it('parses an explicit version', () => {
    expect(parseUri('care://ray/weight_bearing/v3')?.version).toBe(3)
  })
  it('rejects a malformed version segment', () => {
    expect(parseUri('care://ray/weight_bearing/3')).toBeNull()
  })
  it('rejects an unknown scheme', () => {
    expect(parseUri('https://ray/weight_bearing')).toBeNull()
  })
  it('rejects a truncated uri', () => {
    expect(parseUri('care://ray')).toBeNull()
  })
})

describe('audience partition — the safety property', () => {
  it('hides assistant-only records from a user-scoped principal', () => {
    expect(() => fresh().read(uriFor(RAY, 'risk', 'assistant'), userOnly)).toThrow(NotFoundError)
  })

  it('reports NotFound rather than Forbidden, so existence is not confirmed', () => {
    const s = fresh()
    let realMsg = ''
    let fakeMsg = ''
    try { s.read(uriFor(RAY, 'risk', 'assistant'), userOnly) } catch (e) { realMsg = (e as Error).message }
    try { s.read(uriFor(RAY, 'no_such_domain', 'assistant'), userOnly) } catch (e) { fakeMsg = (e as Error).message }
    // A real-but-forbidden record and a nonexistent one must be indistinguishable
    // in shape, or a patient-facing token can probe for internal records.
    expect(realMsg.replace(/risk/, 'X')).toBe(fakeMsg.replace(/no_such_domain/, 'X'))
  })

  it('serves assistant-only records to a principal holding the scope', () => {
    expect(fresh().read(uriFor(RAY, 'risk', 'assistant'), both).value).toContain('Fall risk')
  })

  it('omits assistant-only URIs from list() for a user-scoped principal', () => {
    const uris = fresh().list(userOnly).map((x) => x.uri)
    expect(uris.some((u) => u.startsWith('care-internal://'))).toBe(false)
    // Five speakable domains: weight_bearing, anticoagulant, exercise, contact,
    // exercise_clip. The seed also holds three assistant-only ones.
    expect(uris).toHaveLength(5)
  })

  it('includes both audiences for a dual-scope principal', () => {
    const uris = fresh().list(both).map((x) => x.uri)
    expect(uris).toHaveLength(8)
    expect(uris.filter((u) => u.startsWith('care-internal://'))).toHaveLength(3)
  })

  it('will not let a care:// uri reach an assistant-only record', () => {
    expect(() => fresh().read(uriFor(RAY, 'risk', 'user'), userOnly)).toThrow(NotFoundError)
  })

  it('refuses to change a record audience on a later write', () => {
    expect(() =>
      fresh().publish({
        subject: RAY, topic: 'risk', audience: 'user', value: 'x',
        authorId: 'a', authorLabel: 'a', writtenAt: DEMO_NOW.toISOString(),
      }),
    ).toThrow(/refusing to change audience/)
  })
})

describe('version chain', () => {
  it('is intact after seeding', () => {
    expect(fresh().verify(RAY, 'weight_bearing').intact).toBe(true)
  })

  it('chains v2 to v1', () => {
    const s = fresh()
    s.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    const [v1, v2] = s.versions(RAY, 'weight_bearing')
    expect(v2!.prevHash).toBe(v1!.versionHash)
    expect(s.verify(RAY, 'weight_bearing').intact).toBe(true)
  })

  it('detects tampering and locates the version', () => {
    const s = fresh()
    s._tamper(RAY, 'weight_bearing', 1, 'tampered')
    const v = s.verify(RAY, 'weight_bearing')
    expect(v.intact).toBe(false)
    expect(v.brokenAt).toBe(1)
  })

  it('produces a different hash when the author differs', () => {
    const a = hashVersion(null, 'same', '2026-10-08T09:00:00Z', 'okafor')
    const b = hashVersion(null, 'same', '2026-10-08T09:00:00Z', 'adeyemi')
    expect(a).not.toBe(b)
  })

  it('is deterministic for identical inputs', () => {
    const a = hashVersion(null, 'v', '2026-10-08T09:00:00Z', 'x')
    const b = hashVersion(null, 'v', '2026-10-08T09:00:00Z', 'x')
    expect(a).toBe(b)
  })
})

describe('staleness', () => {
  it('flags a record past its stale_after', () => {
    const s = fresh().staleness(uriFor(RAY, 'anticoagulant', 'user'), userOnly, DEMO_NOW)
    expect(s.stale).toBe(true)
  })
  it('does not flag a record with no stale_after', () => {
    expect(fresh().staleness(uriFor(RAY, 'exercise', 'user'), userOnly, DEMO_NOW).stale).toBe(false)
  })
  it('computes age from writtenAt', () => {
    const s = fresh().staleness(uriFor(RAY, 'exercise', 'user'), userOnly, DEMO_NOW)
    expect(Math.round(s.ageMs / 86_400_000)).toBe(1)
  })
})

describe('revisions and notification', () => {
  it('fires updated only where seeding actually supersedes something', () => {
    // The seed writes weight_bearing twice — the day-1 instruction and the day-2
    // one that replaced it — and every other domain once. `updated` therefore
    // fires exactly once, for the one domain that has a previous version. Any
    // first version firing it would tell a host the plan changed because the
    // server started.
    const s = new LiveResourceStore()
    const fired: string[] = []
    s.onUpdated((u) => fired.push(u))
    seed(s)
    expect(fired).toEqual([uriFor(RAY, 'weight_bearing', 'user')])
  })

  it('fires updated on a revision, with the unversioned uri', () => {
    const s = fresh()
    const fired: string[] = []
    s.onUpdated((u) => fired.push(u))
    s.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    expect(fired).toEqual([uriFor(RAY, 'weight_bearing', 'user')])
  })

  it('serves the newest version by default and old ones by explicit uri', () => {
    const s = fresh()
    s.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    expect(s.read(uriFor(RAY, 'weight_bearing', 'user'), userOnly).value).toBe(STAGED_REVISION.value)
    expect(s.read(uriFor(RAY, 'weight_bearing', 'user', 1), userOnly).version).toBe(1)
  })

  it('unsubscribes listeners', () => {
    const s = fresh()
    const fired: string[] = []
    const off = s.onUpdated((u) => fired.push(u))
    off()
    s.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    expect(fired).toHaveLength(0)
  })
})

describe('seed determinism', () => {
  it('produces identical hashes across runs', () => {
    const a = fresh().versions(RAY, 'weight_bearing')[0]!.versionHash
    const b = fresh().versions(RAY, 'weight_bearing')[0]!.versionHash
    expect(a).toBe(b)
  })
  it('seeds exactly eight records', () => {
    expect(fresh().list(both)).toHaveLength(8)
  })
  it('seeds the superseded day-1 weight-bearing instruction', () => {
    // The retraction has to walk back to a real previous version, not an implied
    // one: `_meta.prevHash` and completion over {version} both need a chain
    // longer than one to demonstrate anything.
    const chain = fresh().versions(RAY, 'weight_bearing')
    expect(chain).toHaveLength(2)
    expect(chain[0]!.value).toContain('No weight through the operated leg')
    expect(chain[1]!.prevHash).toBe(chain[0]!.versionHash)
  })
  it('does not apply the staged revision', () => {
    // It is fired live on stage. A seed that already contained it would make the
    // notification a judge sees a replay of state that was there all along.
    const chain = fresh().versions(RAY, 'weight_bearing')
    expect(chain.map((r) => r.value)).not.toContain(STAGED_REVISION.value)
    expect(chain.at(-1)!.value).toContain('Partial weight-bearing')
  })
})

describe('at rest, with no envelope configured', () => {
  it('admits it is holding plaintext rather than implying encryption', () => {
    const s = fresh()
    expect(s.atRest(RAY, 'weight_bearing', 1)).toBe(
      s.read(uriFor(RAY, 'weight_bearing', 'user', 1), userOnly).value,
    )
    expect(s.atRestReceipt(RAY, 'risk', 1)).toMatchObject({
      uri: 'care-internal://ray/risk/v1',
      encrypted: false,
      algorithm: 'none',
      provider: null,
      keyId: null,
      aad: null,
    })
  })

  it('behaves identically whether the options object is omitted or empty', () => {
    // The envelope option is additive: every caller that predates it must be unaffected.
    const omitted = fresh().versions(RAY, 'weight_bearing')[0]!
    const empty = seed(new LiveResourceStore({})).versions(RAY, 'weight_bearing')[0]!
    expect(empty.versionHash).toBe(omitted.versionHash)
    expect(empty.value).toBe(omitted.value)
  })

  it('will not expose a version that does not exist', () => {
    expect(() => fresh().atRest(RAY, 'weight_bearing', 99)).toThrow(NotFoundError)
  })

  it('receipts the newest version when none is named', () => {
    const s = fresh()
    s.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    expect(s.atRestReceipt(RAY, 'weight_bearing').uri).toBe('care://ray/weight_bearing/v3')
  })
})
