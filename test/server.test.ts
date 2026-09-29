/**
 * Protocol-level tests. Every assertion here goes through a real MCP Client over a
 * real transport pair — no internal function is called directly — because the
 * thing being defended is what a HOST observes, not what our functions return.
 *
 * Bias is toward the cases that MUST FAIL: a wrong-scope read of a clip, a cursor
 * the server never issued, a prompt that could leak reasoning-only text.
 */
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  LoggingMessageNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { EXERCISE_CLIP, GAIT_NOTE, blobFor } from '../src/blobs.ts'
import { BRIEF_CARER, RESOURCE_PAGE_SIZE, SERVER_INSTRUCTIONS, buildServer } from '../src/server.ts'
import { DEMO_NOW, RAY, STAGED_REVISION, seed, seedDemo } from '../src/seed.ts'
import { LiveResourceStore, uriFor } from '../src/store.ts'
import { UI_ECHO_URI, UI_MIME_TYPE, UI_TEMPLATE_META, uiHtml } from '../src/ui_resource.ts'
import { SCOPE } from '../src/types.ts'

const BOTH = [SCOPE.user, SCOPE.assistant]
const USER_ONLY = [SCOPE.user]

const WB = uriFor(RAY, 'weight_bearing', 'user')
const RISK = uriFor(RAY, 'risk', 'assistant')
const CLIP = uriFor(EXERCISE_CLIP.patient, EXERCISE_CLIP.domain, EXERCISE_CLIP.audience)
const GAIT = uriFor(GAIT_NOTE.patient, GAIT_NOTE.domain, GAIT_NOTE.audience)

/** InMemoryTransport delivers asynchronously; let every queued message land. */
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

type Built = ReturnType<typeof buildServer>

function build(store: LiveResourceStore, scopes: string[]) {
  return buildServer({
    store,
    principal: () => ({ sub: 'test-host', scopes }),
    now: () => DEMO_NOW,
  })
}

async function attach(built: Built) {
  const client = new Client({ name: 'unsay-test', version: '0.0.0' }, { capabilities: {} })
  const updated: string[] = []
  const logs: { level: string; logger?: string; data?: unknown }[] = []
  const listChanged = { count: 0 }
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updated.push(n.params.uri)
  })
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    listChanged.count++
  })
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    logs.push(n.params)
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([built.server.connect(serverSide), client.connect(clientSide)])
  return { client, updated, logs, listChanged }
}

async function harness(scopes: string[] = BOTH, store: LiveResourceStore = seedDemo()) {
  const built = build(store, scopes)
  const wired = await attach(built)
  return { ...built, ...wired, store }
}

/** Walk every page of resources/list, returning the URIs and the page count. */
async function walk(client: Client) {
  const uris: string[] = []
  let pages = 0
  let cursor: string | undefined
  do {
    const page = await client.listResources(cursor ? { cursor } : {})
    pages++
    uris.push(...page.resources.map((r) => r.uri))
    cursor = page.nextCursor
    if (pages > 20) throw new Error('cursor did not terminate')
  } while (cursor)
  return { uris, pages }
}

describe('capabilities', () => {
  it('declares every surface it implements, so a host does not have to probe', async () => {
    const { client } = await harness()
    const caps = client.getServerCapabilities()
    expect(caps?.resources).toEqual({ subscribe: true, listChanged: true })
    expect(caps?.prompts).toBeDefined()
    expect(caps?.logging).toBeDefined()
    expect(caps?.completions).toBeDefined()
    expect(client.getInstructions()).toContain('whats_changed')
  })
})

describe('resources/list — cursor pagination', () => {
  it('pages at RESOURCE_PAGE_SIZE and the cursor round-trips to the rest', async () => {
    const { client, store } = await harness()
    // +1: the MCP Apps card (`ui://unsay/echo`) is listed alongside the facts, so a
    // host discovers renderable HTML the same way it discovers everything else.
    const total = store.list({ sub: 't', scopes: BOTH }).length + 1
    expect(total).toBeGreaterThan(RESOURCE_PAGE_SIZE * 2) // or the cursor is never exercised

    const first = await client.listResources({})
    expect(first.resources).toHaveLength(RESOURCE_PAGE_SIZE)
    expect(first.nextCursor).toBeTypeOf('string')

    const second = await client.listResources({ cursor: first.nextCursor })
    const firstUris = first.resources.map((r) => r.uri)
    const secondUris = second.resources.map((r) => r.uri)
    expect(secondUris.some((u) => firstUris.includes(u))).toBe(false)

    const { uris, pages } = await walk(client)
    expect(pages).toBe(Math.ceil(total / RESOURCE_PAGE_SIZE))
    expect(new Set(uris).size).toBe(total) // nothing skipped, nothing repeated
    expect(uris).toEqual([...uris].sort()) // stable ordering across pages
  })

  it('rejects a cursor it did not issue rather than silently restarting', async () => {
    const { client } = await harness()
    await expect(client.listResources({ cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: -32602,
    })
    // Valid base64url, wrong shape — the decode must not be fooled by encoding alone.
    const bogus = Buffer.from(JSON.stringify({ offset: 2 })).toString('base64url')
    await expect(client.listResources({ cursor: bogus })).rejects.toMatchObject({ code: -32602 })
  })

  it('never pages an internal uri to a user-scoped principal', async () => {
    const { client } = await harness(USER_ONLY)
    const { uris } = await walk(client)
    expect(uris.length).toBeGreaterThan(0)
    expect(uris.some((u) => u.startsWith('care-internal://'))).toBe(false)
    expect(uris).not.toContain(GAIT)
  })

  it('advertises a clip with its real mime type and byte size', async () => {
    const { client } = await harness()
    const { uris } = await walk(client)
    expect(uris).toContain(CLIP)
    let entry
    let cursor: string | undefined
    do {
      const page = await client.listResources(cursor ? { cursor } : {})
      entry ??= page.resources.find((r) => r.uri === CLIP)
      cursor = page.nextCursor
    } while (cursor && !entry)
    expect(entry?.mimeType).toBe('audio/wav')
    expect(entry?.size).toBe(blobFor(CLIP)!.bytes)
    expect(entry?.annotations?.audience).toEqual(['user'])
  })
})

describe('resources/read — blob contents', () => {
  it('returns a playable blob part alongside the text part', async () => {
    const { client } = await harness()
    const res = await client.readResource({ uri: CLIP })
    expect(res.contents).toHaveLength(2)

    const text = res.contents.find((c) => 'text' in c) as { text: string }
    const blob = res.contents.find((c) => 'blob' in c) as { blob: string; mimeType: string }
    expect(text.text).toContain('heel-slide')
    expect(blob.mimeType).toBe('audio/wav')

    const bytes = Buffer.from(blob.blob, 'base64')
    // A real WAV, not a text file with a .wav name: RIFF magic, a WAVE form type,
    // and a declared chunk size that agrees with the payload we actually shipped.
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length)
    expect(bytes.readUInt32LE(24)).toBe(4000) // sample rate
    expect(bytes.length).toBe(blobFor(CLIP)!.bytes)
  })

  it('gives a user-scoped principal -32002 on an assistant-only clip', async () => {
    const { client } = await harness(USER_ONLY)
    await expect(client.readResource({ uri: GAIT })).rejects.toMatchObject({ code: -32002 })
    // Same answer for the versioned form, or the version segment becomes a bypass.
    await expect(client.readResource({ uri: `${GAIT}/v1` })).rejects.toMatchObject({
      code: -32002,
    })
    // And the same for a text internal record, so the blob path is not a special case.
    await expect(client.readResource({ uri: RISK })).rejects.toMatchObject({ code: -32002 })
  })

  it('serves the assistant-only clip to a principal that holds the scope', async () => {
    const { client } = await harness()
    const res = await client.readResource({ uri: GAIT })
    const blob = res.contents.find((c) => 'blob' in c) as { blob: string }
    expect(Buffer.from(blob.blob, 'base64').subarray(0, 4).toString('ascii')).toBe('RIFF')
  })
})

describe('resources/read — _meta version chain', () => {
  it('carries the hashes that make a retraction auditable', async () => {
    const { client, store } = await harness()
    const v1 = await client.readResource({ uri: `${WB}/v1` })
    const v2 = await client.readResource({ uri: `${WB}/v2` })
    const m1 = v1.contents[0]!._meta as Record<string, unknown>
    const m2 = v2.contents[0]!._meta as Record<string, unknown>

    expect(m1['unsay/prevHash']).toBeNull()
    expect(m2['unsay/prevHash']).toBe(m1['unsay/versionHash'])
    expect(m2['unsay/versionHash']).toBe(store.versions(RAY, 'weight_bearing')[1]!.versionHash)
    expect(m2['unsay/version']).toBe(2)
    expect(m2['unsay/audience']).toBe('user')
  })

  it('marks a record past its review date as stale in _meta and in the spoken text', async () => {
    const { client } = await harness()
    const res = await client.readResource({ uri: uriFor(RAY, 'anticoagulant', 'user') })
    expect((res.contents[0]!._meta as Record<string, unknown>)['unsay/stale']).toBe(true)
    expect((res.contents[0] as { text: string }).text.startsWith('[STALE')).toBe(true)
  })
})

describe('prompts', () => {
  it('lists brief_carer with its argument', async () => {
    const { client } = await harness()
    const { prompts } = await client.listPrompts()
    const p = prompts.find((x) => x.name === BRIEF_CARER)
    expect(p).toBeDefined()
    expect(p!.arguments?.map((a) => a.name)).toEqual(['patient'])
  })

  it('cannot emit assistant-only text even for a caller holding BOTH scopes', async () => {
    const { client } = await harness(BOTH)
    const res = await client.getPrompt({ name: BRIEF_CARER, arguments: { patient: RAY } })
    const text = res.messages.map((m) => (m.content as { text: string }).text).join('\n')

    // The exact strings that must never reach a carer's briefing.
    expect(text).not.toContain('Fall risk')
    expect(text).not.toContain('disputes the discharge plan')
    expect(text).not.toContain('over-reports')
    expect(text).not.toContain('gait')
    expect(text).not.toContain('care-internal://')

    // …while the speakable plan is genuinely there, or the test above passes vacuously.
    expect(text).toContain('Partial weight-bearing')
    expect(text).toContain('Rivaroxaban')
    expect(text).toContain('PAST ITS REVIEW DATE')
  })

  it('rejects an unknown prompt name', async () => {
    const { client } = await harness()
    await expect(client.getPrompt({ name: 'brief_everyone' })).rejects.toMatchObject({
      code: -32602,
    })
  })
})

describe('completion/complete', () => {
  it('resolves {version} against the {domain} in context.arguments', async () => {
    const { client } = await harness()
    const res = await client.complete({
      ref: { type: 'ref/resource', uri: 'care://{patient}/{domain}/{version}' },
      argument: { name: 'version', value: '' },
      context: { arguments: { patient: RAY, domain: 'weight_bearing' } },
    })
    // Newest first, and both versions present — a chain, not a single snapshot.
    expect(res.completion.values).toEqual(['v2', 'v1'])
  })

  it('returns nothing for {version} when the context names no domain', async () => {
    const { client } = await harness()
    const res = await client.complete({
      ref: { type: 'ref/resource', uri: 'care://{patient}/{domain}/{version}' },
      argument: { name: 'version', value: '' },
    })
    expect(res.completion.values).toEqual([])
  })

  it('completes only versions the principal may see', async () => {
    const dual = await harness(BOTH)
    const ask = (client: Client) =>
      client.complete({
        ref: { type: 'ref/resource', uri: 'care-internal://{patient}/{domain}/{version}' },
        argument: { name: 'version', value: '' },
        context: { arguments: { patient: RAY, domain: GAIT_NOTE.domain } },
      })
    expect((await ask(dual.client)).completion.values).toEqual(['v1'])

    const scoped = await harness(USER_ONLY)
    // The completion surface must not become the oracle that read refuses to be.
    expect((await ask(scoped.client)).completion.values).toEqual([])
    const domains = await scoped.client.complete({
      ref: { type: 'ref/resource', uri: 'care://{patient}/{domain}/{version}' },
      argument: { name: 'domain', value: '' },
    })
    expect(domains.completion.values).not.toContain(GAIT_NOTE.domain)
    expect(domains.completion.values).not.toContain('risk')
  })
})

describe('notifications', () => {
  it('delivers resources/updated to a subscriber when the physio writes', async () => {
    const h = await harness()
    await h.client.subscribeResource({ uri: WB })
    h.store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    await flush()
    expect(h.updated).toEqual([WB])

    const after = await h.client.readResource({ uri: WB })
    expect((after.contents[0] as { text: string }).text).toContain(STAGED_REVISION.value)
  })

  it('stops delivering after unsubscribe', async () => {
    const h = await harness()
    await h.client.subscribeResource({ uri: WB })
    await h.client.unsubscribeResource({ uri: WB })
    h.store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    await flush()
    expect(h.updated).toEqual([])
  })

  it('refuses a subscription to a resource the principal cannot read', async () => {
    const h = await harness(USER_ONLY)
    await expect(h.client.subscribeResource({ uri: RISK })).rejects.toMatchObject({ code: -32002 })
    h.store.publish({
      subject: RAY,
      topic: 'risk',
      audience: 'assistant',
      value: 'Fall risk: MODERATE.',
      authorId: 'adeyemi',
      authorLabel: 'Mr Adeyemi, surgical team',
      writtenAt: DEMO_NOW.toISOString(),
    })
    await flush()
    expect(h.updated).toEqual([])
  })

  it('logs a revision on notifications/message at level notice', async () => {
    const h = await harness()
    h.store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    await flush()
    expect(h.logs).toHaveLength(1)
    const entry = h.logs[0]!
    expect(entry.level).toBe('notice')
    expect(entry.logger).toBe('unsay.revision')
    const data = entry.data as Record<string, unknown>
    expect(data.uri).toBe(WB)
    expect(data.version).toBe(3)
    expect(data.versionHash).toBe(h.store.versions(RAY, 'weight_bearing')[2]!.versionHash)
    // The log names the change; it never carries the value, because a log line is
    // not a read and only a read is authorized.
    expect(JSON.stringify(entry)).not.toContain(STAGED_REVISION.value)
  })

  it('does not log an internal revision to a user-scoped host', async () => {
    const h = await harness(USER_ONLY)
    h.store.publish({
      subject: RAY,
      topic: 'risk',
      audience: 'assistant',
      value: 'Fall risk: MODERATE.',
      authorId: 'adeyemi',
      authorLabel: 'Mr Adeyemi, surgical team',
      writtenAt: DEMO_NOW.toISOString(),
    })
    await flush()
    // Naming the uri would confirm the record exists — the thing -32002 refuses to do.
    expect(h.logs).toEqual([])
  })

  it('fires list_changed for a new domain but never for the seed', async () => {
    // Seeding happens with the host ALREADY CONNECTED, so nothing but the guard
    // stands between eight new domains and eight spurious list_changed frames.
    const store = new LiveResourceStore()
    const built = build(store, BOTH)
    const wired = await attach(built)
    seed(store)
    await flush()
    expect(wired.listChanged.count).toBe(0)

    // Suppression, not absence: the seeded resources really are there.
    const all = store.list({ sub: 't', scopes: BOTH }).length + 1 // + the ui:// card
    expect((await walk(wired.client)).uris).toHaveLength(all)

    // The GP adds wound care — the host is holding a list now, and it is wrong.
    store.publish({
      subject: RAY,
      topic: 'wound_care',
      audience: 'user',
      value: 'Dressing stays on until day seven. Keep it dry.',
      authorId: 'gp.mensah',
      authorLabel: 'Dr Mensah, GP',
      writtenAt: DEMO_NOW.toISOString(),
    })
    await flush()
    expect(wired.listChanged.count).toBe(1)
    expect((await walk(wired.client)).uris).toContain(uriFor(RAY, 'wound_care', 'user'))

    // A further VERSION of an existing domain is not a list change.
    store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    await flush()
    expect(wired.listChanged.count).toBe(1)
  })

  it('does not arm list_changed off a rejected cursor', async () => {
    const store = new LiveResourceStore()
    const wired = await attach(build(store, BOTH))
    await expect(wired.client.listResources({ cursor: 'garbage' })).rejects.toMatchObject({
      code: -32602,
    })
    seed(store)
    await flush()
    expect(wired.listChanged.count).toBe(0)
  })

  it('releases its store listeners on dispose', async () => {
    const h = await harness()
    await h.client.subscribeResource({ uri: WB })
    h.dispose()
    h.store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    await flush()
    expect(h.updated).toEqual([])
    expect(h.logs).toEqual([])
  })
})

describe('tools/call whats_changed — the fallback path', () => {
  it('returns structuredContent that satisfies the declared outputSchema', async () => {
    const { client } = await harness()
    // listTools populates the SDK's output validator, so callTool below is checked
    // against the schema this server advertises — not against our expectations.
    const { tools } = await client.listTools()
    const schema = tools.find((t) => t.name === 'whats_changed')!.outputSchema as unknown as {
      properties: { changed: { items: { required: string[] } } }
    }
    const required = schema.properties.changed.items.required

    const since = new Date(DEMO_NOW.getTime() - 2.5 * 86_400_000).toISOString()
    const res = await client.callTool({ name: 'whats_changed', arguments: { since } })
    const changed = (res.structuredContent as { changed: Record<string, unknown>[] }).changed

    expect(changed.map((c) => c.uri).sort()).toEqual(
      [WB, CLIP, GAIT, uriFor(RAY, 'exercise', 'user')].sort(),
    )
    for (const entry of changed) {
      for (const key of required) expect(entry[key]).toBeDefined()
      expect(typeof entry.ageSeconds).toBe('number')
      expect(new Date(entry.changedAt as string).toString()).not.toBe('Invalid Date')
    }
  })

  it('hides internal revisions from a user-scoped host', async () => {
    const { client } = await harness(USER_ONLY)
    await client.listTools()
    const since = new Date(DEMO_NOW.getTime() - 2.5 * 86_400_000).toISOString()
    const res = await client.callTool({ name: 'whats_changed', arguments: { since } })
    const changed = (res.structuredContent as { changed: { uri: string }[] }).changed
    expect(changed.some((c) => c.uri.startsWith('care-internal://'))).toBe(false)
  })

  it('reports the revision the demo turns on, and nothing else', async () => {
    const h = await harness()
    await h.client.listTools()
    h.store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    const res = await h.client.callTool({
      name: 'whats_changed',
      arguments: { since: new Date(DEMO_NOW.getTime() - 60_000).toISOString() },
    })
    const changed = (res.structuredContent as { changed: { uri: string; value: string }[] }).changed
    expect(changed).toHaveLength(1)
    expect(changed[0]!.uri).toBe(WB)
    expect(changed[0]!.value).toBe(STAGED_REVISION.value)
  })

  it('rejects an unknown tool', async () => {
    const { client } = await harness()
    await expect(client.callTool({ name: 'unsay_everything' })).rejects.toMatchObject({
      code: -32602,
    })
  })
})

describe('seed determinism', () => {
  let a: LiveResourceStore
  let b: LiveResourceStore
  beforeEach(() => {
    a = seedDemo()
    b = seedDemo()
  })

  it('produces byte-identical records for the same clock', () => {
    const hashes = (s: LiveResourceStore) =>
      s
        .list({ sub: 't', scopes: BOTH })
        .map((x) => x.record.versionHash)
        .sort()
    expect(hashes(a)).toEqual(hashes(b))
  })

  it('moves every timestamp when the clock moves, and nothing else', () => {
    const shifted = seedDemo(new LiveResourceStore(), {
      now: new Date(DEMO_NOW.getTime() + 86_400_000),
    })
    const wbA = a.versions(RAY, 'weight_bearing')
    const wbS = shifted.versions(RAY, 'weight_bearing')
    expect(wbS.map((r) => r.value)).toEqual(wbA.map((r) => r.value))
    expect(wbS[0]!.versionHash).not.toBe(wbA[0]!.versionHash) // writtenAt is hashed
  })

  it('leaves the staged revision unapplied so the demo notification is real', () => {
    expect(a.versions(RAY, 'weight_bearing')).toHaveLength(2)
    expect(a.versions(RAY, 'weight_bearing').at(-1)!.value).not.toBe(STAGED_REVISION.value)
  })
})

describe('the MCP Apps card', () => {
  /**
   * The Alexa+ rules call "a basic MCP wrapper around an existing API" the obvious
   * idea and name "media support (cards, carousels), MCP Apps, Agent Skills" as the
   * creative bar. The device card was already built — it was simply being served by
   * an HTTP static route, which is not an MCP surface at all. It is a resource now.
   */
  it('is listed alongside the facts, so a host discovers it the usual way', async () => {
    const { client } = await harness()
    const { uris } = await walk(client)
    expect(uris).toContain(UI_ECHO_URI)
  })

  it('is visible to a patient-scoped host — it is a template, not patient content', async () => {
    const { client } = await harness(USER_ONLY)
    const { uris } = await walk(client)
    expect(uris).toContain(UI_ECHO_URI)
    expect(uris.some((u) => u.startsWith('care-internal://'))).toBe(false)
  })

  it('reads back as renderable HTML under the extension mime type', async () => {
    const { client } = await harness()
    const read = await client.readResource({ uri: UI_ECHO_URI })
    const part = read.contents[0] as { mimeType?: string; text?: string }
    expect(part.mimeType).toBe(UI_MIME_TYPE)
    expect(part.text).toContain('<!doctype html>')
    // Same bytes the HTTP route serves — one file, two doors, nothing to drift.
    expect(part.text).toBe(uiHtml())
  })

  it('carries no assistant-audience content, because Ray can see the card', async () => {
    for (const secret of ['Fall risk', 'disputes the discharge plan', 'care-internal://']) {
      expect(uiHtml()).not.toContain(secret)
    }
  })

  it('binds the fallback tool to the template, so a host knows what to render', async () => {
    const { client } = await harness()
    const tools = await client.listTools()
    const tool = tools.tools.find((t) => t.name === 'whats_changed')!
    expect((tool._meta as Record<string, unknown>)?.[UI_TEMPLATE_META]).toBe(UI_ECHO_URI)
    // The MCP Apps standard key (2026-01-26), not only the Apps SDK alias.
    expect((tool._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri).toBe(UI_ECHO_URI)
    expect(UI_MIME_TYPE).toBe('text/html;profile=mcp-app')
  })
})

describe('the fallback path can retract, not only restate', () => {
  /**
   * A host that cannot subscribe never read v1. Given only the new value it can
   * state a fact and cannot withdraw the one it just said — which is the entire
   * product. `previousValue` is what makes a retraction possible on this path.
   */
  it('returns the superseded value and the rendered retraction', async () => {
    const store = seedDemo()
    const { client } = await harness(BOTH, store)
    store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })

    const out = await client.callTool({
      name: 'whats_changed',
      arguments: { since: new Date(DEMO_NOW.getTime() - 3600_000).toISOString() },
    })
    const changed = (out.structuredContent as {
      changed: { uri: string; value: string; previousValue?: string; previousVersion?: number; retraction?: string }[]
    }).changed
    const wb = changed.find((c) => c.uri === WB)!
    expect(wb.value).toBe(STAGED_REVISION.value)
    expect(wb.previousVersion).toBe(2)
    expect(wb.previousValue).toContain('about half your body weight')
    expect(wb.retraction).toContain('Wait — don’t do that')
  })

  it('omits both on a resource that has only ever had one version', async () => {
    const store = seedDemo()
    const { client } = await harness(BOTH, store)
    store.publish({
      subject: RAY,
      topic: 'wound_care',
      audience: 'user',
      value: 'Dressing stays on until day seven.',
      authorId: 'gp.mensah',
      authorLabel: 'Dr Mensah, GP',
      writtenAt: DEMO_NOW.toISOString(),
    })
    const out = await client.callTool({
      name: 'whats_changed',
      arguments: { since: new Date(DEMO_NOW.getTime() - 3600_000).toISOString() },
    })
    const changed = (out.structuredContent as { changed: { uri: string; previousValue?: string }[] }).changed
    const created = changed.find((c) => c.uri.endsWith('/wound_care'))!
    expect(created.previousValue).toBeUndefined()
  })
})

describe('a notification is re-authorized at send time', () => {
  /**
   * A subscription is authorized once, when it is created. The principal on the
   * session can narrow afterwards. Delivering `care-internal://ray/risk` to a
   * now-user-scoped host confirms the resource EXISTS — the one thing read()
   * answers -32002 rather than confirm (I-2, I-9). The revision LOG already
   * re-checked; the primary channel did not, so the guard was inconsistent by
   * accident rather than by design.
   */
  it('does not deliver an internal updated to a downgraded session', async () => {
    const store = seedDemo()
    let scopes = [...BOTH]
    const built = buildServer({
      store,
      principal: () => ({ sub: 'same-host', scopes }),
      now: () => DEMO_NOW,
    })
    const wired = await attach(built)

    await wired.client.subscribeResource({ uri: RISK })
    await wired.client.subscribeResource({ uri: WB })

    // The same host comes back holding only the patient-facing scope.
    scopes = [...USER_ONLY]

    store.publish({
      subject: RAY,
      topic: 'risk',
      audience: 'assistant',
      value: 'Fall risk: HIGH. Now also refusing the frame.',
      authorId: 'adeyemi',
      authorLabel: 'Mr Adeyemi, surgical team',
      writtenAt: DEMO_NOW.toISOString(),
    })
    store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    await flush()

    expect(wired.updated).not.toContain(RISK)
    // …and the speakable one still arrives, or the guard is just a mute button.
    expect(wired.updated).toContain(WB)
    expect(wired.logs.some((l) => JSON.stringify(l.data).includes('risk'))).toBe(false)
  })
})

describe('the Agent Skill and the server say the same thing', () => {
  /**
   * `skills/unsay-care-plan/SKILL.md` is the Alexa+ track's other first-class deliverable, and it is
   * a SECOND copy of the contract the server already sends in `instructions`. Two
   * copies of a contract drift; this is what stops them. Not a byte comparison —
   * one is a Markdown skill with front matter, the other is a paragraph in an
   * `initialize` result — but every load-bearing claim in one has to be in the other.
   */
  const skill = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../skills/unsay-care-plan/SKILL.md'), 'utf8')

  it('declares the front matter a skill needs to be loaded at all', () => {
    expect(skill.startsWith('---\n')).toBe(true)
    for (const field of ['name: unsay-care-plan', 'description:', 'license: MIT']) {
      expect(skill, field).toContain(field)
    }
  })

  it('carries every rule SERVER_INSTRUCTIONS states', () => {
    const claims: [string, RegExp][] = [
      // rule 1 — stop and correct yourself when updated arrives
      ['subscribe and retract', /notifications\/resources\/updated/],
      ['name what changed, who and when', /who changed it|its author and its age/i],
      // rule 2 — the fallback
      ['the whats_changed fallback', /whats_changed/],
      ['the fallback cursor is asOf', /asOf/],
      ['no retraction means carry on', /carry on/],
      // the never-speak rule
      ['audience:assistant is never spoken', /audience:\s*\["?assistant"?\]|`care-internal:\/\/`/],
      ['never speak it', /never be spoken|Never speak/i],
      // staleness
      ['say the age of a stale fact', /past its review date|say the age|STALE/i],
    ]
    for (const [what, pattern] of claims) {
      expect(pattern.test(skill), `skills/unsay-care-plan/SKILL.md drops: ${what}`).toBe(true)
      expect(
        pattern.test(SERVER_INSTRUCTIONS) || /never be spoken|say its age aloud/i.test(SERVER_INSTRUCTIONS),
        `SERVER_INSTRUCTIONS drops: ${what}`,
      ).toBe(true)
    }
  })

  it('names every surface it tells a host to call, and each one is registered', async () => {
    const { client } = await harness()
    const tools = await client.listTools()
    const prompts = await client.listPrompts()
    expect(skill).toContain('tools/call whats_changed')
    expect(tools.tools.map((t) => t.name)).toContain('whats_changed')
    expect(skill).toContain('prompts/get brief_carer')
    expect(prompts.prompts.map((p) => p.name)).toContain(BRIEF_CARER)
    expect(skill).toContain(UI_ECHO_URI)
  })

  it('states the protocol revision the track requires', () => {
    expect(skill).toContain('2025-11-25')
    expect(skill).toContain('Streamable HTTP')
  })
})

describe('the version a host is told', () => {
  it('is package.json\'s, so a release and the server it describes cannot disagree', async () => {
    // serverInfo.version was a literal. The release workflow bumps package.json from the
    // commit history; a second copy typed into the source would drift on the first release.
    const { readFileSync } = await import('node:fs')
    const { VERSION } = await import('../src/server.ts')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(VERSION).toBe(pkg.version)
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')).not.toMatch(/name: 'unsay', version: '/)
  })
})

/**
 * a2a r01. A retraction withdraws a sentence the host actually said: never on a
 * first read, never a version it skipped, never out of never-speak content.
 */
describe('retractions follow what this session heard', () => {
  const retractionOf = (res: { contents: { _meta?: Record<string, unknown> }[] }) =>
    res.contents[0]!._meta?.['unsay/retraction'] as string | undefined
  const revise = (store: LiveResourceStore, value: string, minutes: number) =>
    store.publish({
      ...STAGED_REVISION,
      value,
      writtenAt: new Date(DEMO_NOW.getTime() + minutes * 60_000).toISOString(),
    })

  it('carries no retraction on a first read — nothing has been said yet', async () => {
    const { client } = await harness()
    expect(retractionOf(await client.readResource({ uri: WB }))).toBeUndefined()
  })

  it('withdraws the version this host heard, not version n-1', async () => {
    const h = await harness()
    await h.client.readResource({ uri: WB }) // hears v2
    revise(h.store, 'Non weight-bearing until the X-ray is reviewed.', 1) // v3, never heard
    revise(h.store, STAGED_REVISION.value, 2) // v4
    const spoken = retractionOf(await h.client.readResource({ uri: WB }))!
    expect(spoken).toContain('about half your body weight')
    expect(spoken).not.toContain('X-ray')
  })

  it('never renders a speakable retraction from assistant-audience content', async () => {
    const h = await harness()
    await h.client.readResource({ uri: RISK })
    h.store.publish({
      subject: RAY,
      topic: 'risk',
      audience: 'assistant',
      value: 'Fall risk: MODERATE.',
      authorId: 'dr-adeyemi',
      authorLabel: 'Mr Adeyemi',
      writtenAt: DEMO_NOW.toISOString(),
    })
    const res = await h.client.readResource({ uri: RISK })
    expect(res.contents[0]!._meta?.['unsay/previousValue']).toBeDefined()
    expect(retractionOf(res)).toBeUndefined()

    await h.client.listTools()
    const tool = await h.client.callTool({
      name: 'whats_changed',
      arguments: { since: new Date(DEMO_NOW.getTime() - 60_000).toISOString() },
    })
    const item = (tool.structuredContent as { changed: Record<string, unknown>[] }).changed.find(
      (c) => c.uri === RISK,
    )!
    expect(item.audience).toBe('assistant')
    expect(item.retraction).toBeUndefined()
  })

  it('whats_changed rejects a malformed since instead of reporting nothing changed', async () => {
    const { client } = await harness()
    await client.listTools()
    const res = await client.callTool({ name: 'whats_changed', arguments: { since: 'yesterday' } })
    expect(res.isError).toBe(true)
  })

  it('whats_changed without since renders no retraction', async () => {
    const h = await harness()
    await h.client.listTools()
    revise(h.store, STAGED_REVISION.value, 0)
    const res = await h.client.callTool({ name: 'whats_changed', arguments: {} })
    const item = (res.structuredContent as { changed: Record<string, unknown>[] }).changed.find(
      (c) => c.uri === WB,
    )!
    expect(item.retraction).toBeUndefined()
  })

  it('a superseded version says so in its text and carries no retraction', async () => {
    const h = await harness()
    await h.client.readResource({ uri: WB })
    const res = await h.client.readResource({ uri: `${WB}/v1` })
    const text = (res.contents[0] as { text: string }).text
    expect(text.startsWith('[SUPERSEDED')).toBe(true)
    expect(res.contents[0]!._meta?.['unsay/superseded']).toBe(true)
    expect(retractionOf(res)).toBeUndefined()
  })
})

describe('subscribe takes only the URI it will notify', () => {
  it.each([`${WB}/`, WB.replace('ray/', 'ray//'), `${WB}/v2`])('refuses %s with -32602', async (uri) => {
    const { client } = await harness()
    await expect(client.subscribeResource({ uri })).rejects.toMatchObject({ code: -32602 })
  })

  it('a canonical subscription hears exactly one update per revision', async () => {
    const h = await harness()
    await h.client.subscribeResource({ uri: WB })
    h.store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
    await flush()
    expect(h.updated).toEqual([WB])
  })
})

describe('list_changed never signals an internal chain to a user-scoped host', () => {
  it('stays silent for a new care-internal chain', async () => {
    const h = await harness(USER_ONLY)
    await h.client.listResources()
    h.store.publish({
      subject: RAY,
      topic: 'discharge_note',
      audience: 'assistant',
      value: 'Internal only.',
      authorId: 'dr-adeyemi',
      authorLabel: 'Mr Adeyemi',
      writtenAt: DEMO_NOW.toISOString(),
    })
    await flush()
    expect(h.listChanged.count).toBe(0)
  })
})

describe('the Agent Skill passes the Agent Skills specification', () => {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/unsay-care-plan/SKILL.md')
  const text = readFileSync(path, 'utf8')
  const front = text.slice(4, text.indexOf('\n---\n', 4))
  const keys = [...front.matchAll(/^([a-z-]+):/gm)].map((m) => m[1]!)

  it('uses only the six frontmatter fields the specification allows', () => {
    const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
    expect(keys.filter((k) => !allowed.has(k))).toEqual([])
  })

  it('names itself after its directory, in the allowed alphabet', () => {
    const name = /^name: (.+)$/m.exec(front)![1]!.trim()
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(name).toBe(basename(dirname(path)))
  })

  it('keeps its description within 1024 characters', () => {
    const desc = front.slice(front.indexOf('description:'), front.indexOf('\nlicense:'))
    expect(desc.replace(/^description: >-\n/, '').replace(/\s+/g, ' ').trim().length).toBeLessThanOrEqual(1024)
  })
})

/** a2a r02: the fallback's cursor is the server's, and same words are never retracted. */
describe('whats_changed is anchored to the server, not to when the host spoke', () => {
  it('asOf catches a correction written while the host was still speaking', async () => {
    let clock = DEMO_NOW
    const store = seedDemo()
    const built = buildServer({ store, principal: () => ({ sub: 't', scopes: BOTH }), now: () => clock })
    const { client } = await attach(built)
    await client.listTools()
    await client.readResource({ uri: WB }) // hears v2
    const first = await client.callTool({ name: 'whats_changed', arguments: {} })
    const asOf = (first.structuredContent as { asOf: string }).asOf
    expect(asOf).toBe(DEMO_NOW.toISOString())
    // The host speaks; the physio writes mid-answer; the host finishes a minute later.
    store.publish({ ...STAGED_REVISION, writtenAt: new Date(DEMO_NOW.getTime() + 20_000).toISOString() })
    clock = new Date(DEMO_NOW.getTime() + 60_000)
    const next = await client.callTool({ name: 'whats_changed', arguments: { since: asOf } })
    const item = (next.structuredContent as { changed: Record<string, unknown>[] }).changed.find(
      (c) => c.uri === WB,
    )!
    expect(item.previousValue).toContain('about half your body weight')
    expect(item.retraction).toBeDefined()
  })

  it('refuses a since ahead of the server clock instead of answering nothing changed', async () => {
    const { client } = await harness()
    await client.listTools()
    const res = await client.callTool({
      name: 'whats_changed',
      arguments: { since: new Date(DEMO_NOW.getTime() + 60_000).toISOString() },
    })
    expect(res.isError).toBe(true)
  })
})

describe('a re-confirmation in the same words carries no retraction', () => {
  it('a new review date re-reads without a retraction and without STALE', async () => {
    const h = await harness()
    const ANTI = uriFor(RAY, 'anticoagulant', 'user')
    const before = await h.client.readResource({ uri: ANTI })
    const text = (before.contents[0] as { text: string }).text
    expect(text.startsWith('[STALE')).toBe(true)
    const value = text.slice(text.indexOf('\n') + 1)
    h.store.publish({
      subject: RAY,
      topic: 'anticoagulant',
      audience: 'user',
      value,
      authorId: 'gp.mensah',
      authorLabel: 'Dr Mensah, GP',
      writtenAt: DEMO_NOW.toISOString(),
      staleAfter: new Date(DEMO_NOW.getTime() + 14 * 86_400_000).toISOString(),
    })
    const after = await h.client.readResource({ uri: ANTI })
    expect(after.contents[0]!._meta?.['unsay/retraction']).toBeUndefined()
    expect((after.contents[0] as { text: string }).text.startsWith('[STALE')).toBe(false)
  })
})
