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
    expect(uris).toHaveLength(4)
  })

  it('includes both audiences for a dual-scope principal', () => {
    expect(fresh().list(both)).toHaveLength(6)
  })

  it('will not let a care:// uri reach an assistant-only record', () => {
    expect(() => fresh().read(uriFor(RAY, 'risk', 'user'), userOnly)).toThrow(NotFoundError)
  })

  it('refuses to change a record audience on a later write', () => {
    expect(() =>
      fresh().publish({
        patient: RAY, domain: 'risk', audience: 'user', value: 'x',
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
  it('does not fire updated for the first version', () => {
    const s = new LiveResourceStore()
    const fired: string[] = []
    s.onUpdated((u) => fired.push(u))
    seed(s)
    expect(fired).toHaveLength(0)
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
  it('seeds exactly six records', () => {
    expect(fresh().list(both)).toHaveLength(6)
  })
  it('does not apply the staged revision', () => {
    expect(fresh().versions(RAY, 'weight_bearing')).toHaveLength(1)
  })
})
