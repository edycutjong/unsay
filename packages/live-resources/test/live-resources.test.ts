/**
 * Standalone proof that the package works on its own.
 *
 * Two rules this file keeps deliberately:
 *   1. It imports from '../src/index.ts' and NOTHING else — if the public entry
 *      point does not export it, this suite cannot reach it either, which is the
 *      only way to notice a re-export that was forgotten.
 *   2. It knows nothing about the server this was extracted from. The scenario is
 *      an incident channel, chosen because it is not that server's domain: a
 *      package that only works for its birthplace is not a package.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  AudiencePartition,
  DEFAULT_PARTITION,
  LiveResourceError,
  LiveResourceStore,
  NotFoundError,
  PartitionConfigError,
  ReservedSeparatorError,
  ResourceNotifier,
  hashVersion,
  recordAad,
} from '../src/index.ts'
import type { NotificationTarget, PublishInput, ValueCodec } from '../src/index.ts'

// ── the scenario ─────────────────────────────────────────────────────────────

const PARTITION = new AudiencePartition({
  user: { scheme: 'incident://', scope: 'incident.read.user' },
  assistant: { scheme: 'incident-internal://', scope: 'incident.read.assistant' },
})

const RESPONDER = { sub: 'responder', scopes: ['incident.read.user'] }
const ANALYST = { sub: 'analyst', scopes: ['incident.read.user', 'incident.read.assistant'] }

const T0 = new Date('2026-03-01T10:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString()

const revision = (over: Partial<PublishInput> = {}): PublishInput => ({
  subject: 'inc-402',
  topic: 'status',
  audience: 'user',
  value: 'Checkout is degraded. Payments are queued, not lost.',
  authorId: 'nadia',
  authorLabel: 'Nadia, incident commander',
  writtenAt: at(0),
  ...over,
})

function seeded(store = new LiveResourceStore({ partition: PARTITION })) {
  store.publish(revision())
  store.publish(
    revision({
      topic: 'customer_note',
      value: 'We are on it. No action needed from you.',
      writtenAt: at(2),
      staleAfter: at(30),
      priority: 0.4,
    }),
  )
  store.publish(
    revision({
      topic: 'blast_radius',
      audience: 'assistant',
      value: 'Root cause is an expired signing key. Do not disclose: legal review pending.',
      writtenAt: at(3),
      priority: 1,
    }),
  )
  return store
}

// ── a real codec, so the at-rest claims are not mimed ────────────────────────

/** AES-256-GCM with the AAD the store hands it. ~20 lines is the whole seam. */
function gcmCodec(key = randomBytes(32)): ValueCodec {
  return {
    name: 'aes-256-gcm/test',
    seal(plaintext, aad) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      c.setAAD(Buffer.from(aad))
      const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')
    },
    open(sealed, aad) {
      const raw = Buffer.from(sealed, 'base64')
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
      d.setAAD(Buffer.from(aad))
      d.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
    },
    describe(sealed) {
      const raw = Buffer.from(sealed, 'base64')
      if (raw.length < 29) return null
      return {
        algorithm: 'AES-256-GCM',
        provider: 'test',
        keyId: 'test/v1',
        ivHex: raw.subarray(0, 12).toString('hex'),
        tagHex: raw.subarray(12, 28).toString('hex'),
        ciphertextBytes: raw.length - 28,
      }
    },
  }
}

// ── URIs ─────────────────────────────────────────────────────────────────────

describe('the partition', () => {
  it('maps a scheme to an audience and back', () => {
    expect(PARTITION.uriFor('inc-402', 'status', 'user')).toBe('incident://inc-402/status')
    expect(PARTITION.parseUri('incident-internal://inc-402/blast_radius')?.audience).toBe('assistant')
    expect(PARTITION.parseUri('incident://inc-402/status/v3')?.version).toBe(3)
  })

  it('returns null for anything it did not issue', () => {
    for (const uri of ['https://inc-402/status', 'incident://inc-402', 'incident://a/b/3', 'incident://a/b/v1/x']) {
      expect(PARTITION.parseUri(uri)).toBeNull()
    }
  })

  it('refuses a configuration that does not actually partition', () => {
    const lane = { scheme: 'x://', scope: 'x.read' }
    expect(() => new AudiencePartition({ user: lane, assistant: lane })).toThrow(PartitionConfigError)
    expect(
      () => new AudiencePartition({ user: lane, assistant: { scheme: 'y://', scope: 'x.read' } }),
    ).toThrow(/scope/)
    expect(
      () => new AudiencePartition({ user: lane, assistant: { scheme: 'y', scope: 'y.read' } }),
    ).toThrow(/:\/\//)
  })

  it('ships a default so a first server needs no configuration', () => {
    expect(DEFAULT_PARTITION.uriFor('a', 'b', 'assistant')).toBe('live-internal://a/b')
  })
})

// ── the safety property ──────────────────────────────────────────────────────

describe('audience enforcement', () => {
  it('hides the other lane from a principal without its scope', () => {
    const store = seeded()
    expect(() => store.read('incident-internal://inc-402/blast_radius', RESPONDER)).toThrow(NotFoundError)
    expect(store.read('incident-internal://inc-402/blast_radius', ANALYST).value).toContain('signing key')
  })

  it('answers "not found", not "forbidden", so existence cannot be probed', () => {
    const store = seeded()
    const message = (topic: string) => {
      try {
        store.read(`incident-internal://inc-402/${topic}`, RESPONDER)
        return 'no throw'
      } catch (e) {
        return (e as Error).message.replace(topic, 'X')
      }
    }
    expect(message('blast_radius')).toBe(message('no_such_topic'))
  })

  it('maps to JSON-RPC -32002 so an MCP server can put it on the wire unchanged', () => {
    try {
      seeded().read('incident-internal://inc-402/blast_radius', RESPONDER)
      expect.unreachable()
    } catch (e) {
      expect((e as NotFoundError).code).toBe(-32002)
      expect(e).toBeInstanceOf(LiveResourceError)
    }
  })

  it('omits the other lane from list()', () => {
    const store = seeded()
    expect(store.list(RESPONDER).map((x) => x.uri)).toEqual([
      'incident://inc-402/status',
      'incident://inc-402/customer_note',
    ])
    expect(store.list(ANALYST)).toHaveLength(3)
  })

  it('refuses to move an existing resource across the boundary', () => {
    const store = seeded()
    expect(() => store.publish(revision({ audience: 'assistant', writtenAt: at(5) }))).toThrow(
      /refusing to change audience/,
    )
  })
})

// ── revisions and notifications ──────────────────────────────────────────────

describe('revisions', () => {
  it('fires updated for a revision and listChanged for a first appearance', () => {
    const store = new LiveResourceStore({ partition: PARTITION })
    const updated: string[] = []
    let listChanged = 0
    store.onUpdated((uri) => updated.push(uri))
    store.onListChanged(() => (listChanged += 1))

    store.publish(revision())
    expect(updated).toEqual([])
    expect(listChanged).toBe(1)

    store.publish(revision({ value: 'Checkout is recovering.', writtenAt: at(9) }))
    expect(updated).toEqual(['incident://inc-402/status'])
    expect(listChanged).toBe(1)
  })

  it('notifies with the unversioned URI, which is what a client subscribed to', () => {
    const store = seeded()
    const seen: string[] = []
    store.onUpdated((uri) => seen.push(uri))
    store.publish(revision({ value: 'Recovered.', writtenAt: at(20) }))
    expect(seen).toEqual(['incident://inc-402/status'])
    expect(store.read('incident://inc-402/status', RESPONDER).value).toBe('Recovered.')
    expect(store.read('incident://inc-402/status/v1', RESPONDER).value).toContain('degraded')
  })

  it('stops calling a listener that unsubscribed', () => {
    const store = seeded()
    const seen: string[] = []
    const off = store.onUpdated((uri) => seen.push(uri))
    store.publish(revision({ value: 'one', writtenAt: at(11) }))
    off()
    store.publish(revision({ value: 'two', writtenAt: at(12) }))
    expect(seen).toHaveLength(1)
  })
})

// ── the chain ────────────────────────────────────────────────────────────────

describe('the hash chain', () => {
  it('links each revision to its predecessor', () => {
    const store = seeded()
    store.publish(revision({ value: 'Recovered.', writtenAt: at(20) }))
    const [v1, v2] = store.versions('inc-402', 'status')
    expect(v1!.prevHash).toBeNull()
    expect(v2!.prevHash).toBe(v1!.versionHash)
    expect(store.verify('inc-402', 'status')).toMatchObject({ intact: true, versions: 2 })
  })

  it('locates a tampered value exactly', () => {
    const store = seeded()
    store._tamper('inc-402', 'status', 1, 'Everything is fine.')
    expect(store.verify('inc-402', 'status')).toMatchObject({
      intact: false,
      brokenAt: 1,
      uri: 'incident://inc-402/status',
    })
  })

  it('is reproducible, and separates two authors writing identical text', () => {
    expect(hashVersion(null, 'v', at(0), 'nadia')).toBe(hashVersion(null, 'v', at(0), 'nadia'))
    expect(hashVersion(null, 'v', at(0), 'nadia')).not.toBe(hashVersion(null, 'v', at(0), 'omar'))
  })

  it('reports staleness against the record own date, not the wall clock', () => {
    const store = seeded()
    const uri = 'incident://inc-402/customer_note'
    expect(store.staleness(uri, RESPONDER, new Date(at(10))).stale).toBe(false)
    const late = store.staleness(uri, RESPONDER, new Date(at(45)))
    expect(late.stale).toBe(true)
    expect(late.ageMs).toBe(43 * 60_000)
  })

  it('reserves the AAD separator so two identities cannot collide', () => {
    expect(recordAad({ subject: 'inc-402', topic: 'status', version: 2, audience: 'user' })).toBe(
      'inc-402|status|v2|user',
    )
    expect(() =>
      recordAad({ subject: 'inc|402', topic: 'status', version: 1, audience: 'user' }),
    ).toThrow(ReservedSeparatorError)
  })
})

// ── at rest ──────────────────────────────────────────────────────────────────

describe('the at-rest codec seam', () => {
  it('admits plaintext rather than implying encryption', () => {
    const store = seeded()
    expect(store.codec).toBeNull()
    expect(store.atRestReceipt('inc-402', 'blast_radius')).toMatchObject({
      uri: 'incident-internal://inc-402/blast_radius/v1',
      encrypted: false,
      algorithm: 'none',
      aad: null,
    })
  })

  it('stores ciphertext and still serves plaintext, with an identical chain', () => {
    const plain = seeded()
    const sealed = seeded(new LiveResourceStore({ partition: PARTITION, codec: gcmCodec() }))

    expect(sealed.atRest('inc-402', 'blast_radius')).not.toContain('signing key')
    expect(sealed.read('incident-internal://inc-402/blast_radius', ANALYST).value).toContain('signing key')
    // The chain hashes plaintext, so encryption at rest changes nothing an auditor sees.
    expect(sealed.versions('inc-402', 'status')[0]!.versionHash).toBe(
      plain.versions('inc-402', 'status')[0]!.versionHash,
    )
    expect(sealed.verify('inc-402', 'status').intact).toBe(true)
  })

  it('binds ciphertext to its slot, so moved bytes will not open', () => {
    const store = seeded(new LiveResourceStore({ partition: PARTITION, codec: gcmCodec() }))
    // The attack the scope check cannot stop: someone with write access to storage
    // pastes the internal record's bytes into the one the responder is allowed to read.
    store._tamper('inc-402', 'status', 1, store.atRest('inc-402', 'blast_radius', 1))
    expect(() => store.read('incident://inc-402/status/v1', RESPONDER)).toThrow()
    expect(store.verify('inc-402', 'status')).toMatchObject({
      intact: false,
      brokenAt: 1,
      expected: '<undecryptable at rest>',
    })
  })

  it('issues a receipt off the stored bytes, without the key', () => {
    const store = seeded(new LiveResourceStore({ partition: PARTITION, codec: gcmCodec() }))
    expect(store.atRestReceipt('inc-402', 'blast_radius', 1)).toMatchObject({
      encrypted: true,
      algorithm: 'AES-256-GCM',
      provider: 'test',
      keyId: 'test/v1',
      aad: 'inc-402|blast_radius|v1|assistant',
    })
    expect(store.atRestReceipt('inc-402', 'blast_radius', 1).ciphertextBytes).toBeGreaterThan(0)
  })

  it('reports unrecognisable storage instead of throwing', () => {
    const store = seeded(new LiveResourceStore({ partition: PARTITION, codec: gcmCodec() }))
    store._tamper('inc-402', 'status', 1, 'not base64 anything')
    expect(store.atRestReceipt('inc-402', 'status', 1).algorithm).toBe('unreadable')
  })

  it('will not receipt a version that does not exist', () => {
    expect(() => seeded().atRest('inc-402', 'status', 99)).toThrow(NotFoundError)
  })
})

// ── the MCP wiring ───────────────────────────────────────────────────────────

function fakeServer() {
  return {
    updated: [] as string[],
    listChanged: 0,
    async sendResourceUpdated({ uri }: { uri: string }) {
      this.updated.push(uri)
    },
    async sendResourceListChanged() {
      this.listChanged += 1
    },
  }
}

describe('ResourceNotifier', () => {
  it('only sends updated for a URI that was subscribed', () => {
    const store = seeded()
    const target = fakeServer()
    const notifier = new ResourceNotifier({ store, target: target as NotificationTarget })

    store.publish(revision({ value: 'unsubscribed change', writtenAt: at(6) }))
    expect(target.updated).toEqual([])

    notifier.subscribe('incident://inc-402/status')
    store.publish(revision({ value: 'subscribed change', writtenAt: at(7) }))
    expect(target.updated).toEqual(['incident://inc-402/status'])

    notifier.unsubscribe('incident://inc-402/status')
    store.publish(revision({ value: 'after unsubscribe', writtenAt: at(8) }))
    expect(target.updated).toHaveLength(1)
  })

  it('stays silent about list changes until a list has actually been served', () => {
    const store = new LiveResourceStore({ partition: PARTITION })
    const target = fakeServer()
    const notifier = new ResourceNotifier({ store, target: target as NotificationTarget })

    seeded(store) // seeding is not news to a client holding no list
    expect(target.listChanged).toBe(0)
    expect(notifier.listArmed).toBe(false)

    store.list(RESPONDER)
    notifier.armListChanged()
    store.publish(revision({ topic: 'postmortem', value: 'Scheduled.', writtenAt: at(60) }))
    expect(target.listChanged).toBe(1)
  })

  it('reports every revision to onRevision, subscribed or not', () => {
    const store = seeded()
    const onRevision = vi.fn()
    new ResourceNotifier({ store, target: fakeServer() as NotificationTarget, onRevision })
    store.publish(revision({ value: 'change', writtenAt: at(9) }))
    expect(onRevision).toHaveBeenCalledWith('incident://inc-402/status')
  })

  it('shrugs off a disconnected host but reports every other failure', async () => {
    const store = seeded()
    const onError = vi.fn()
    const notifier = new ResourceNotifier({
      store,
      target: {
        sendResourceUpdated: async ({ uri }: { uri: string }) => {
          throw new Error(uri.endsWith('status') ? 'Not connected' : 'boom')
        },
        sendResourceListChanged: async () => {},
      } as NotificationTarget,
      onError,
    })
    notifier.subscribe('incident://inc-402/status')
    notifier.subscribe('incident://inc-402/customer_note')

    store.publish(revision({ value: 'while nobody is attached', writtenAt: at(10) }))
    await Promise.resolve()
    expect(onError).not.toHaveBeenCalled()

    store.publish(revision({ topic: 'customer_note', value: 'update', writtenAt: at(11) }))
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'incident://inc-402/customer_note')
  })

  it('detaches from the store on dispose', () => {
    const store = seeded()
    const target = fakeServer()
    const notifier = new ResourceNotifier({ store, target: target as NotificationTarget })
    notifier.subscribe('incident://inc-402/status')
    notifier.dispose()
    store.publish(revision({ value: 'after dispose', writtenAt: at(12) }))
    expect(target.updated).toEqual([])
    expect(notifier.subscriptions.size).toBe(0)
  })
})
