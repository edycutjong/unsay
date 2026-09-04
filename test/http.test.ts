/**
 * The HTTP surface, over real sockets on an ephemeral port.
 *
 * These tests are written the wrong way round on purpose: nearly all of them
 * assert that something FAILS. A read that succeeds proves the happy path; a
 * user-scoped token that gets -32002 on `care-internal://` proves the product.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { AuditLog } from '../src/audit.ts'
import { Envelope, LocalKeyProvider } from '../src/envelope.ts'
import {
  createHttpServer,
  mintToken,
  replayAllowed,
  signWriteBody,
  urisNamedBy,
  verifyToken,
  WRITE_SKEW_MS,
} from '../src/http.ts'
import type { UnsayHttpServer } from '../src/http.ts'
import { LiveResourceStore, uriFor } from '../src/store.ts'
import { RAY, seedDemo } from '../src/seed.ts'
import { SCOPE } from '../src/types.ts'

const TOKEN_SECRET = 'test-token-secret'
const WRITE_SECRET = 'test-write-secret'

const WB = uriFor(RAY, 'weight_bearing', 'user')
const RISK = uriFor(RAY, 'risk', 'assistant')

const MCP_ACCEPT = 'application/json, text/event-stream'
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'raw-probe', version: '0.0.0' },
  },
}

let srv: UnsayHttpServer
let audit: AuditLog

beforeAll(async () => {
  audit = new AuditLog()
  srv = await createHttpServer({
    store: seedDemo(new LiveResourceStore()),
    audit,
    tokenSecret: TOKEN_SECRET,
    writeSecret: WRITE_SECRET,
    announce: false,
  })
})

afterAll(async () => {
  await srv.close()
})

const token = (scopes: string[], extra: { sub?: string; secret?: string; ttlSeconds?: number; audience?: string } = {}) =>
  mintToken({
    sub: extra.sub ?? 'alexa-host',
    scopes,
    audience: extra.audience ?? srv.resourceUrl,
    secret: extra.secret ?? TOKEN_SECRET,
    ttlSeconds: extra.ttlSeconds,
  })

const postInitialize = (headers: Record<string, string> = {}) =>
  fetch(`${srv.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: MCP_ACCEPT, ...headers },
    body: JSON.stringify(INITIALIZE),
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await sleep(10)
  }
}

interface Connected {
  client: Client
  updates: string[]
  close: () => Promise<void>
}

/** A real MCP client over Streamable HTTP, carrying a real bearer token. */
async function connect(scopes: string[], sub = 'alexa-host'): Promise<Connected> {
  const before = srv.stats.sseOpens
  const client = new Client({ name: 'unsay-http-test', version: '0.0.0' }, { capabilities: {} })
  const updates: string[] = []
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updates.push(n.params.uri)
  })
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token(scopes, { sub })}` } },
  })
  await client.connect(transport)
  // The standalone GET stream is opened by the client after `initialized`. Nothing
  // is delivered down a stream that has not attached yet, so wait for the request
  // to reach us before anything publishes.
  await waitFor(() => srv.stats.sseOpens > before)
  await sleep(60)
  return { client, updates, close: () => client.close() }
}

/** Walks every page — resources/list is cursor-paginated, and a leak could hide on page 2. */
async function allResourceUris(client: Client): Promise<string[]> {
  const uris: string[] = []
  let cursor: string | undefined
  do {
    const page = await client.listResources(cursor ? { cursor } : {})
    uris.push(...page.resources.map((r) => r.uri))
    cursor = page.nextCursor
  } while (cursor)
  return uris
}

function signedWrite(bodyObj: unknown, opts: { timestamp?: string; mutate?: (s: string) => string } = {}) {
  const raw = Buffer.from(JSON.stringify(bodyObj), 'utf8')
  const timestamp = opts.timestamp ?? new Date().toISOString()
  const signature = signWriteBody(WRITE_SECRET, timestamp, raw)
  const sent = opts.mutate ? Buffer.from(opts.mutate(raw.toString('utf8')), 'utf8') : raw
  return fetch(`${srv.baseUrl}/write`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unsay-timestamp': timestamp,
      'x-unsay-signature': signature,
    },
    body: sent,
  })
}

// ── RFC 9728 ────────────────────────────────────────────────────────────────

describe('protected resource metadata', () => {
  it('serves the RFC 9728 fields a client needs to find the authorization server', async () => {
    const res = await fetch(`${srv.baseUrl}/.well-known/oauth-protected-resource`)
    expect(res.status).toBe(200)
    const meta = await res.json()
    expect(meta.resource).toBe(srv.resourceUrl)
    expect(meta.authorization_servers.length).toBeGreaterThan(0)
    expect(meta.scopes_supported).toEqual(['care.read.user', 'care.read.assistant', 'care.write'])
    expect(meta.bearer_methods_supported).toEqual(['header'])
  })

  it('also answers at the path-suffixed location a compliant client derives', async () => {
    const res = await fetch(`${srv.baseUrl}/.well-known/oauth-protected-resource/mcp`)
    expect(res.status).toBe(200)
    expect((await res.json()).resource).toBe(srv.resourceUrl)
  })
})

// ── the token is the boundary ───────────────────────────────────────────────

describe('bearer token enforcement', () => {
  it('401s an unauthenticated MCP request and points at resource_metadata', async () => {
    const res = await postInitialize()
    expect(res.status).toBe(401)
    const challenge = res.headers.get('www-authenticate') ?? ''
    expect(challenge).toMatch(/^Bearer /)
    expect(challenge).toContain(`resource_metadata="${srv.resourceMetadataUrl}"`)
  })

  it('rejects a token signed with the wrong secret', async () => {
    const res = await postInitialize({
      Authorization: `Bearer ${token(['care.read.user'], { secret: 'not-the-secret' })}`,
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  it('rejects an expired token', async () => {
    const res = await postInitialize({
      Authorization: `Bearer ${token(['care.read.user'], { ttlSeconds: -60 })}`,
    })
    expect(res.status).toBe(401)
  })

  it('rejects a token minted for another resource', async () => {
    const res = await postInitialize({
      Authorization: `Bearer ${token(['care.read.assistant'], { audience: 'https://someone-else.example/mcp' })}`,
    })
    expect(res.status).toBe(401)
  })

  it('rejects an unsigned token — the signature is not optional', async () => {
    const good = token(['care.read.assistant'])
    const [h, p] = good.split('.')
    expect((await postInitialize({ Authorization: `Bearer ${h}.${p}` })).status).toBe(401)

    // alg:"none" with an empty signature, the classic JWT forgery.
    const forgedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'unsay+jwt' })).toString('base64url')
    expect((await postInitialize({ Authorization: `Bearer ${forgedHeader}.${p}.` })).status).toBe(401)
  })

  it('will not take a scope list from the client — scopes come from the signature', () => {
    const good = token(['care.read.user'])
    const [h, p, s] = good.split('.') as [string, string, string]
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
    claims.scope = 'care.read.user care.read.assistant'
    const escalated = Buffer.from(JSON.stringify(claims)).toString('base64url')
    expect(() =>
      verifyToken(`${h}.${escalated}.${s}`, { secret: TOKEN_SECRET, audience: srv.resourceUrl }),
    ).toThrow(/bad_signature/)
  })
})

// ── the audience partition, over the wire ───────────────────────────────────

describe('audience partition over Streamable HTTP', () => {
  it('never lists a care-internal:// URI to a user-scoped principal', async () => {
    const c = await connect(['care.read.user'], 'user-scoped')
    try {
      const uris = await allResourceUris(c.client)
      expect(uris.length).toBeGreaterThan(0)
      expect(uris.filter((u) => u.startsWith('care-internal://'))).toEqual([])
    } finally {
      await c.close()
    }
  })

  it('answers -32002 when a user-scoped principal reads an internal URI', async () => {
    const c = await connect(['care.read.user'], 'user-scoped')
    try {
      await expect(c.client.readResource({ uri: RISK })).rejects.toMatchObject({ code: -32002 })
      await expect(c.client.readResource({ uri: `${RISK}/v1` })).rejects.toMatchObject({ code: -32002 })
      // The template list is a second way to learn the internal scheme exists.
      const tpl = await c.client.listResourceTemplates()
      expect(tpl.resourceTemplates.some((t) => t.uriTemplate.startsWith('care-internal://'))).toBe(false)
    } finally {
      await c.close()
    }
  })

  it('lets a care.read.assistant principal read exactly what the user-scoped one could not', async () => {
    const c = await connect(['care.read.user', 'care.read.assistant'], 'reasoner')
    try {
      const read = await c.client.readResource({ uri: RISK })
      expect((read.contents[0] as { text: string }).text).toContain('Fall risk')
      const uris = await allResourceUris(c.client)
      expect(uris.some((u) => u.startsWith('care-internal://'))).toBe(true)
    } finally {
      await c.close()
    }
  })
})

// ── the write path ──────────────────────────────────────────────────────────

describe('POST /write', () => {
  const revision = (value: string) => ({
    patient: RAY,
    domain: 'weight_bearing',
    audience: 'user',
    value,
    authorId: 'okafor',
    authorLabel: 'Sarah Okafor, physio',
    priority: 0.9,
  })

  it('rejects a body mutated after signing, and audits the attempt', async () => {
    const before = srv.store.versions(RAY, 'weight_bearing').length
    const rejectedBefore = audit.rejected().length

    // The signature is computed over the pristine body; one byte of the value is
    // then flipped in transit. Same length, so only the MAC can catch it.
    const res = await signedWrite(revision('Full weight-bearing as tolerated.'), {
      mutate: (s) => s.replace('Full weight-bearing', 'FULL weight-bearing'),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(srv.store.versions(RAY, 'weight_bearing').length).toBe(before)
    expect(audit.rejected().length).toBe(rejectedBefore + 1)
    expect(audit.last()).toMatchObject({ outcome: 'rejected', reason: 'bad_signature', via: 'hmac' })
  })

  it('rejects an unsigned write', async () => {
    const res = await fetch(`${srv.baseUrl}/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(revision('No signature at all.')),
    })
    expect(res.status).toBe(401)
    expect(audit.last()).toMatchObject({ reason: 'missing_signature', via: 'none' })
  })

  it('rejects a replayed request whose timestamp is outside the skew window', async () => {
    const stale = new Date(Date.now() - WRITE_SKEW_MS - 60_000).toISOString()
    const res = await signedWrite(revision('Replayed from yesterday.'), { timestamp: stale })
    expect(res.status).toBe(401)
    expect(audit.last()).toMatchObject({ reason: 'stale_timestamp', via: 'hmac' })
  })

  it('rejects a bearer write without care.write', async () => {
    const res = await fetch(`${srv.baseUrl}/write`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token(['care.read.user'], { sub: 'nurse' })}`,
      },
      body: JSON.stringify(revision('Read scope is not write scope.')),
    })
    expect(res.status).toBe(401)
    expect(audit.last()).toMatchObject({ reason: 'insufficient_scope', via: 'bearer', actor: 'nurse' })
  })

  it('accepts a correctly signed write and delivers resources/updated to a subscriber', async () => {
    const c = await connect(['care.read.user', 'care.read.assistant'], 'reasoner')
    try {
      await c.client.subscribeResource({ uri: WB })
      const before = srv.store.versions(RAY, 'weight_bearing').length

      const res = await signedWrite(revision('Full weight-bearing as tolerated.'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.uri).toBe(WB)
      expect(body.version).toBe(before + 1)
      expect(body.versionHash).toMatch(/^[0-9a-f]{64}$/)

      await waitFor(() => c.updates.includes(WB), 5000)
      expect(audit.last()).toMatchObject({ outcome: 'accepted', reason: 'ok', via: 'hmac', actor: 'okafor', uri: WB })

      // …and the correction is what a re-read now returns.
      const read = await c.client.readResource({ uri: WB })
      expect((read.contents[0] as { text: string }).text).toContain('Full weight-bearing as tolerated.')
    } finally {
      await c.close()
    }
  })

  it('never records a credential in an audit row', () => {
    const serialised = JSON.stringify(audit.rows())
    expect(serialised).not.toContain(WRITE_SECRET)
    expect(serialised).not.toContain(TOKEN_SECRET)
    expect(serialised).not.toMatch(/[0-9a-f]{64}/) // no hex MAC, presented or expected
    expect(serialised).not.toContain('Bearer ')
    expect(audit.rows().length).toBeGreaterThan(3)
  })
})

// ── /verify ─────────────────────────────────────────────────────────────────

describe('GET /verify', () => {
  it('replays the hash chain for anyone, and shows only speakable URIs', async () => {
    const res = await fetch(`${srv.baseUrl}/verify`, { headers: { accept: 'application/json' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.intact).toBe(true)
    expect(body.chains.length).toBeGreaterThan(0)
    expect(body.versions).toBeGreaterThanOrEqual(body.chains.length)
    // Public, so it must not confirm that the internal half of the graph exists.
    expect(JSON.stringify(body)).not.toContain('care-internal://')
  })

  it('includes internal chains only for a care.read.assistant token', async () => {
    const res = await fetch(`${srv.baseUrl}/verify`, {
      headers: { accept: 'application/json', Authorization: `Bearer ${token(['care.read.user', 'care.read.assistant'])}` },
    })
    expect(JSON.stringify(await res.json())).toContain('care-internal://')
  })

  it('serves a plain-text view when the caller does not ask for JSON', async () => {
    const res = await fetch(`${srv.baseUrl}/verify`, { headers: { accept: 'text/plain' } })
    expect(res.headers.get('content-type')).toContain('text/plain')
    const text = await res.text()
    expect(text).toContain('INTACT')
    expect(text).toContain(WB)
  })

  it('locates the exact version a tampered chain breaks at', async () => {
    const tampered = seedDemo(new LiveResourceStore())
    const solo = await createHttpServer({
      store: tampered,
      tokenSecret: TOKEN_SECRET,
      writeSecret: WRITE_SECRET,
      announce: false,
    })
    try {
      tampered._tamper(RAY, 'weight_bearing', 1, 'Full weight-bearing — forged.')
      const res = await fetch(`${solo.baseUrl}/verify?uri=${encodeURIComponent(WB)}`, {
        headers: { accept: 'application/json' },
      })
      const verdict = await res.json()
      expect(verdict.uri).toBe(WB)
      expect(verdict.intact).toBe(false)
      expect(verdict.brokenAt).toBe(1)
    } finally {
      await solo.close()
    }
  })
})

// ── the surfaces the pages depend on ────────────────────────────────────────

describe('CORS', () => {
  it('answers the preflight a browser sends before any authorized request', async () => {
    // This used to be a 405, which kills every cross-origin call from web/ before
    // it is ever made — and does it in the browser, where no server log sees it.
    const res = await fetch(`${srv.baseUrl}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.test')
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    for (const h of ['authorization', 'x-unsay-signature', 'x-unsay-timestamp', 'mcp-session-id', 'last-event-id']) {
      expect(allowed).toContain(h)
    }
  })

  it('exposes the two response headers a browser client cannot work without', async () => {
    // mcp-session-id: without it a browser MCP host cannot read the session it was
    // just granted. www-authenticate: without it a 401 carries no discovery hint.
    const res = await postInitialize({ origin: 'https://example.test' })
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase()
    expect(exposed).toContain('mcp-session-id')
    expect(exposed).toContain('www-authenticate')
  })

  it('still refuses an unauthenticated request that carries an Origin', async () => {
    // CORS is not authentication. A permissive allow-origin must not become one.
    const res = await postInitialize({ origin: 'https://example.test' })
    expect(res.status).toBe(401)
  })
})

describe('the three pages are served from this process', () => {
  it('serves the landing page at / and at /index.html', async () => {
    for (const path of ['/', '/index.html']) {
      const res = await fetch(`${srv.baseUrl}${path}`)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('<title>')
    }
  })

  it('serves the clinician and device screens', async () => {
    for (const path of ['/clinician.html', '/echo.html']) {
      const res = await fetch(`${srv.baseUrl}${path}`)
      expect(res.status, path).toBe(200)
    }
  })

  it('serves the documents the landing page cites, so no proof link is a dead end', async () => {
    // Under `npm start` these used to 404, and the page's own probe then rendered
    // four amber "Not reachable from this deployment" lines under the section whose
    // job is to prove rigour. The artifacts were on disk the whole time.
    for (const [path, needle] of [
      ['/README.md', 'Unsay'],
      ['/DEMO.md', 'npm run verify'],
      ['/FRICTION.md', 'F-002'],
      ['/LICENSE', 'MIT'],
      ['/skill/SKILL.md', 'unsay-care-plan'],
      ['/docs/proof/bench.txt', 'lands mid-sentence'],
      ['/packages/live-resources/src/store.ts', 'read('],
    ] as const) {
      const res = await fetch(`${srv.baseUrl}${path}`)
      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toContain(needle)
    }
  })

  it('maps no request path onto the filesystem', async () => {
    // Both allowlists are literal key tables, so there is nothing for a traversal to
    // reach and no sibling of a listed file comes with it — asserted, not assumed.
    for (const path of [
      '/../package.json',
      '/..%2fpackage.json',
      '/package.json',
      '/.env',
      '/src/envelope.ts',        // a sibling of the two source files that ARE listed
      '/docs/proof/../../package.json',
      '/web/index.html',         // the page is at /index.html; the path is not a directory
    ]) {
      const res = await fetch(`${srv.baseUrl}${path}`)
      expect(res.status, path).not.toBe(200)
    }
  })
})

describe('/write reports who was actually notified', () => {
  // Its own server. The shared one has accumulated sessions from earlier tests, and
  // a subscriber count is only meaningful against a known set of them — which is
  // also the honest caveat: a host that vanishes without a DELETE stays counted
  // until its session is closed.
  let own: UnsayHttpServer
  beforeAll(async () => {
    own = await createHttpServer({
      store: seedDemo(new LiveResourceStore()),
      tokenSecret: TOKEN_SECRET,
      writeSecret: WRITE_SECRET,
      announce: false,
    })
  })
  afterAll(async () => {
    await own.close()
  })

  const write = (value: string) => {
    const raw = Buffer.from(JSON.stringify(revision(value)), 'utf8')
    const timestamp = new Date().toISOString()
    return fetch(`${own.baseUrl}/write`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-unsay-timestamp': timestamp,
        'x-unsay-signature': signWriteBody(WRITE_SECRET, timestamp, raw),
      },
      body: new Uint8Array(raw),
    })
  }

  const revision = (value: string) => ({
    patient: RAY,
    domain: 'weight_bearing',
    audience: 'user',
    value,
    authorId: 'okafor',
    authorLabel: 'Sarah Okafor, physio',
    priority: 0.9,
  })

  it('counts zero subscribers when nobody is listening', async () => {
    const res = await write('Nobody is listening to this one.')
    expect(res.status).toBe(200)
    const body = await res.json()
    // A constant `notified: true` would let a clinician receipt claim a host was
    // corrected when none was attached — the {success:true} failure, on the one
    // screen where it would be read as a clinical confirmation.
    expect(body.subscribers).toBe(0)
    expect(body.notified).toBe(false)
  })

  it('counts the subscriber that is actually holding the URI', async () => {
    const client = new Client({ name: 'unsay-count-test', version: '0.0.0' }, { capabilities: {} })
    const updates: string[] = []
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri)
    })
    const before = own.stats.sseOpens
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${own.baseUrl}/mcp`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${mintToken({ sub: 'echo-show', scopes: ['care.read.user'], audience: own.resourceUrl, secret: TOKEN_SECRET })}`,
          },
        },
      }),
    )
    try {
      await waitFor(() => own.stats.sseOpens > before)
      await sleep(60)
      await client.subscribeResource({ uri: WB })

      const body = await (await write('One host is listening.')).json()
      expect(body.subscribers).toBe(1)
      expect(body.notified).toBe(true)
      await waitFor(() => updates.includes(WB), 5000)
    } finally {
      await client.close()
    }
  })
})

describe('/verify carries an at-rest receipt read from the stored bytes', () => {
  it('admits plaintext rather than implying encryption', async () => {
    const res = await fetch(`${srv.baseUrl}/verify`, { headers: { accept: 'application/json' } })
    const body = await res.json()
    expect(body.atRest).toContain('PLAINTEXT')
    expect(body.receipts.every((r: { encrypted: boolean }) => !r.encrypted)).toBe(true)
  })

  it('names the provider, key, IV and tag of sealed bytes without holding the key', async () => {
    const envelope = await Envelope.create(new LocalKeyProvider(Buffer.from('d'.repeat(64), 'hex')), {
      announce: false,
    })
    const sealed = await createHttpServer({
      store: seedDemo(new LiveResourceStore({ envelope })),
      tokenSecret: TOKEN_SECRET,
      writeSecret: WRITE_SECRET,
      announce: false,
    })
    try {
      const res = await fetch(`${sealed.baseUrl}/verify`, { headers: { accept: 'application/json' } })
      const body = await res.json()
      expect(body.atRest).toContain('AES-256-GCM')
      const wb = body.receipts.find((r: { uri: string }) => r.uri.startsWith(WB))
      expect(wb).toMatchObject({ encrypted: true, algorithm: 'AES-256-GCM', provider: 'local-hkdf' })
      expect(wb.aad).toBe('ray|weight_bearing|v2|user')
      expect(wb.ivHex).toMatch(/^[0-9a-f]{24}$/)
      expect(wb.tagHex).toMatch(/^[0-9a-f]{32}$/)
      // The chain still replays: it hashes the plaintext, so an auditor holding the
      // log and no key can verify it exactly as they could before encryption existed.
      expect(body.intact).toBe(true)
    } finally {
      await sealed.close()
    }
  })

  it('never puts a plaintext value in the receipt', async () => {
    const res = await fetch(`${srv.baseUrl}/verify`, { headers: { accept: 'application/json' } })
    const text = await res.text()
    expect(text).not.toContain('Rivaroxaban')
    expect(text).not.toContain('Fall risk')
  })
})

describe('logging/setLevel is honoured, not merely served', () => {
  /**
   * Declaring the `logging` capability makes the SDK answer `logging/setLevel` with
   * `{}` — a success result — whether or not anything filters. This server used to
   * return that success and then deliver every notice regardless, because
   * `sendLoggingMessage()` was called with no session id and the SDK's per-session
   * level filter therefore looked up `undefined` and missed every time.
   *
   * ARCHITECTURE.md told a judge "a host can turn the revision log down". This is
   * the test that makes that sentence true, and R10 in one line: a declared
   * capability nothing exercises is a capability that is not there.
   */
  let own: UnsayHttpServer
  beforeAll(async () => {
    own = await createHttpServer({
      store: seedDemo(new LiveResourceStore()),
      tokenSecret: TOKEN_SECRET,
      writeSecret: WRITE_SECRET,
      announce: false,
    })
  })
  afterAll(async () => {
    await own.close()
  })

  async function attach() {
    const client = new Client({ name: 'unsay-log-test', version: '0.0.0' }, { capabilities: {} })
    const logs: string[] = []
    const updates: string[] = []
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      logs.push(n.params.level)
    })
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri)
    })
    const before = own.stats.sseOpens
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${own.baseUrl}/mcp`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${mintToken({
              sub: 'log-host',
              scopes: ['care.read.user', 'care.read.assistant'],
              audience: own.resourceUrl,
              secret: TOKEN_SECRET,
            })}`,
          },
        },
      }),
    )
    while (own.stats.sseOpens <= before) await sleep(10)
    await sleep(60)
    await client.subscribeResource({ uri: WB })
    return { client, logs, updates }
  }

  const revise = (value: string) =>
    own.store.publish({
      subject: RAY,
      topic: 'weight_bearing',
      audience: 'user',
      value,
      authorId: 'okafor',
      authorLabel: 'Sarah Okafor, physio',
      writtenAt: new Date().toISOString(),
    })

  it('delivers the revision notice at the default level', async () => {
    const { client, logs } = await attach()
    try {
      revise('Full weight-bearing as tolerated. (default level)')
      await waitFor(() => logs.length > 0)
      expect(logs).toContain('notice')
    } finally {
      await client.close()
    }
  })

  it('suppresses it at emergency, and still delivers resources/updated', async () => {
    const { client, logs, updates } = await attach()
    try {
      await client.setLoggingLevel('emergency')
      const logsBefore = logs.length
      const updatesBefore = updates.length
      revise('Full weight-bearing as tolerated. (emergency level)')
      await waitFor(() => updates.length > updatesBefore)
      await sleep(120) // give a stray log message time to arrive and fail this
      expect(logs.length, 'a notice survived level:emergency').toBe(logsBefore)
      // The correction itself must NOT be suppressed with it: a host that turned
      // the log channel down still has to be able to retract.
      expect(updates.at(-1)).toBe(WB)
    } finally {
      await client.close()
    }
  })

  it('does not let one session mute another', async () => {
    // The level is filed per transport session id. A server that stored one global
    // level would let a logging sidecar silence the device screen's channel.
    const quiet = await attach()
    const loud = await attach()
    try {
      await quiet.client.setLoggingLevel('emergency')
      const quietBefore = quiet.logs.length
      revise('Full weight-bearing as tolerated. (two sessions)')
      await waitFor(() => loud.logs.length > 0)
      await sleep(120)
      expect(quiet.logs.length).toBe(quietBefore)
      expect(loud.logs.length).toBeGreaterThan(0)
    } finally {
      await quiet.client.close()
      await loud.client.close()
    }
  })
})

describe('/write attributes to the principal it verified', () => {
  let own: UnsayHttpServer
  let ownAudit: AuditLog
  beforeAll(async () => {
    ownAudit = new AuditLog()
    own = await createHttpServer({
      store: seedDemo(new LiveResourceStore()),
      audit: ownAudit,
      tokenSecret: TOKEN_SECRET,
      writeSecret: WRITE_SECRET,
      announce: false,
    })
  })
  afterAll(async () => {
    await own.close()
  })

  const bearerWrite = (body: Record<string, unknown>, sub: string) =>
    fetch(`${own.baseUrl}/write`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${mintToken({
          sub,
          scopes: ['care.write'],
          audience: own.resourceUrl,
          secret: TOKEN_SECRET,
        })}`,
      },
      body: JSON.stringify(body),
    })

  it('records the verified token subject, not the authorId in the body', async () => {
    /**
     * The forgery this closes: a `care.write` holder posts `authorId: "adeyemi"`,
     * the write is accepted, and the audit row names Mr Adeyemi while the principal
     * that actually presented a credential appears in no row at all. SPEC I-14
     * promises every write attempt is attributable — on the one path where an
     * identity HAD been proved, the proof was being thrown away.
     */
    const res = await bearerWrite(
      {
        patient: RAY,
        domain: 'weight_bearing',
        audience: 'user',
        value: 'Full weight-bearing as tolerated. (impersonation attempt)',
        authorId: 'adeyemi',
        authorLabel: 'Mr Adeyemi, surgical team',
      },
      'mallory',
    )
    expect(res.status).toBe(200)
    const row = ownAudit.last()!
    expect(row.via).toBe('bearer')
    expect(row.actor).toBe('mallory')
    expect(row.actor).not.toBe('adeyemi')
  })

  it('still lets the claimed author reach the record, which the chain then freezes', async () => {
    // T-4, unchanged and still disclosed: with one shared write secret `authorId`
    // is CLAIMED. What changed is that the claim no longer erases the verified
    // identity from the trail.
    const latest = own.store.versions(RAY, 'weight_bearing').at(-1)!
    expect(latest.authorLabel).toBe('Mr Adeyemi, surgical team')
  })

  it('refuses a patient or domain carrying a path separator', async () => {
    /**
     * `patient: "ray/evil"` used to publish `care://ray/evil/d`, which parseUri()
     * then reads as a malformed version segment and refuses forever — an
     * append-only record nobody can read or supersede, still occupying a cursor
     * page. `|` was already refused because the envelope reserves it as the AAD
     * separator; `/` was not.
     */
    for (const body of [
      { patient: 'ray/evil', domain: 'weight_bearing' },
      { patient: RAY, domain: 'weight_bearing/v99' },
    ]) {
      const res = await bearerWrite(
        {
          ...body,
          audience: 'user',
          value: 'Full weight-bearing as tolerated.',
          authorId: 'okafor',
          authorLabel: 'Sarah Okafor, physio',
        },
        'okafor',
      )
      expect(res.status, JSON.stringify(body)).toBe(401)
      expect(ownAudit.last()!.reason).toBe('invalid_fields')
    }
    const uris = own.store.list({ sub: 't', scopes: [SCOPE.user] }).map((x) => x.uri)
    expect(uris.some((u) => u.includes('evil') || u.includes('v99'))).toBe(false)
  })
})

// ── the resume path, re-authorized ──────────────────────────────────────────

describe('a resumed SSE stream is re-authorized, not replayed blind', () => {
  /**
   * The hole this closes was reproducible against a running server. A session
   * opened with `care.read.assistant`, subscribed to `care-internal://ray/risk`,
   * then resumed with `Last-Event-ID` under a NARROWED token of the same subject,
   * and was handed back the internal URI, its version, its author, its timestamp
   * and both hash-chain links — through `notifications/resources/updated` and the
   * revision log channel alike. Both live channels re-authorize at send time
   * (`canNotify`, `logRevision`); replay did not, so the whole guard could be
   * walked around by dropping a stream and reconnecting. SPEC I-2, I-9.
   */
  const frames = async (res: Response, ms: number) => {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    const deadline = Date.now() + ms
    try {
      while (Date.now() < deadline) {
        const race = await Promise.race([
          reader.read(),
          sleep(deadline - Date.now()).then(() => 'timeout' as const),
        ])
        if (race === 'timeout') break
        if (race.done) break
        text += dec.decode(race.value, { stream: true })
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return text
  }

  it('withholds an internal URI from a resume whose principal has narrowed', async () => {
    const own = await createHttpServer({
      store: seedDemo(new LiveResourceStore()),
      tokenSecret: TOKEN_SECRET,
      writeSecret: WRITE_SECRET,
      announce: false,
    })
    const bearer = (scopes: string[]) =>
      `Bearer ${mintToken({ sub: 'downgrade-probe', scopes, audience: own.resourceUrl, secret: TOKEN_SECRET })}`
    const wide = bearer([SCOPE.user, SCOPE.assistant])
    const narrow = bearer([SCOPE.user])

    try {
      const init = await fetch(`${own.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: MCP_ACCEPT, Authorization: wide },
        body: JSON.stringify(INITIALIZE),
      })
      const sid = init.headers.get('mcp-session-id')!
      expect(sid).toBeTruthy()
      await init.text()

      const post = (body: unknown, auth: string) =>
        fetch(`${own.baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: MCP_ACCEPT,
            'mcp-session-id': sid,
            Authorization: auth,
          },
          body: JSON.stringify(body),
        })

      await (await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, wide)).text()
      await (
        await post(
          { jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: RISK } },
          wide,
        )
      ).text()

      // The wide session attaches its standalone stream and takes the live revision.
      const live = await fetch(`${own.baseUrl}/mcp`, {
        method: 'GET',
        headers: { accept: 'text/event-stream', 'mcp-session-id': sid, Authorization: wide },
      })
      expect(live.ok).toBe(true)
      const liveFrames = frames(live, 900)
      await sleep(120)

      const raw = Buffer.from(
        JSON.stringify({
          patient: RAY,
          domain: 'risk',
          audience: 'assistant',
          value: 'Fall risk: HIGH. Reviewed today.',
          authorId: 'mensah',
          authorLabel: 'Dr Mensah, GP',
        }),
        'utf8',
      )
      const ts = new Date().toISOString()
      const wrote = await fetch(`${own.baseUrl}/write`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-unsay-timestamp': ts,
          'x-unsay-signature': signWriteBody(WRITE_SECRET, ts, raw),
        },
        body: raw,
      })
      expect(wrote.status).toBe(200)

      const delivered = await liveFrames
      expect(delivered, 'the wide session never saw the live revision').toContain('care-internal://')
      const ids = [...delivered.matchAll(/^id: (.+)$/gm)].map((m) => m[1]!)
      // Resume from BEFORE the internal frames, so there is something to withhold.
      const resumeFrom = ids[0]!
      expect(resumeFrom).toBeTruthy()

      // The transport allows one connection per stream id, so the dropped stream
      // has to be released server-side before a resume can attach — exactly what a
      // proxy timeout does, and what scripts/probe_resume.ts does deliberately.
      own.dropStreams()
      await sleep(40)

      // The same session, the same `sub`, a token that no longer carries
      // care.read.assistant. Every stored frame naming an internal URI is dropped.
      const narrowed = await fetch(`${own.baseUrl}/mcp`, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          'mcp-session-id': sid,
          'last-event-id': resumeFrom,
          Authorization: narrow,
        },
      })
      expect(narrowed.ok).toBe(true)
      const leaked = await frames(narrowed, 500)
      expect(leaked, 'a narrowed resume was handed an internal URI').not.toContain('care-internal://')
      expect(leaked, 'a narrowed resume was handed an internal chain link').not.toContain('versionHash')
      expect(own.events.replaysWithheld).toBeGreaterThan(0)

      // Control: the guard drops frames because of the SCOPE, not because replay
      // is broken. The same cursor under the original token still delivers them.
      own.dropStreams()
      await sleep(40)
      const again = await fetch(`${own.baseUrl}/mcp`, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          'mcp-session-id': sid,
          'last-event-id': resumeFrom,
          Authorization: wide,
        },
      })
      const replayed = await frames(again, 500)
      expect(replayed, 'the wide resume replayed nothing — the test proves nothing').toContain(
        'care-internal://',
      )
    } finally {
      await own.close()
    }
  }, 20_000)

  it('replays a frame that names no partitioned URI unchanged', () => {
    const ping = { jsonrpc: '2.0', id: 9, result: {} } as unknown as Parameters<typeof replayAllowed>[0]
    expect(urisNamedBy(ping)).toEqual([])
    expect(replayAllowed(ping, undefined)).toBe(true)
  })

  it('reads the URI out of every frame shape that carries one', () => {
    const updated = {
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: RISK },
    } as unknown as Parameters<typeof replayAllowed>[0]
    const logged = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'notice', logger: 'unsay.revision', data: { uri: RISK, version: 2 } },
    } as unknown as Parameters<typeof replayAllowed>[0]
    const readResult = {
      jsonrpc: '2.0',
      id: 4,
      result: { contents: [{ uri: RISK, text: 'Fall risk: HIGH' }] },
    } as unknown as Parameters<typeof replayAllowed>[0]
    const listResult = {
      jsonrpc: '2.0',
      id: 5,
      result: { resources: [{ uri: WB }, { uri: RISK }] },
    } as unknown as Parameters<typeof replayAllowed>[0]

    for (const frame of [updated, logged, readResult, listResult]) {
      expect(urisNamedBy(frame)).toContain(RISK)
      expect(replayAllowed(frame, { sub: 'x', scopes: [SCOPE.user] })).toBe(false)
      expect(replayAllowed(frame, { sub: 'x', scopes: [SCOPE.user, SCOPE.assistant] })).toBe(true)
    }
  })

  it('fails closed on a URI this partition did not issue', () => {
    const alien = {
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: 'ui://unsay/echo' },
    } as unknown as Parameters<typeof replayAllowed>[0]
    // Same rule canNotify() and logRevision() apply: a URI we cannot parse is one
    // we cannot authorize, not one we may assume is harmless.
    expect(replayAllowed(alien, { sub: 'x', scopes: [SCOPE.user, SCOPE.assistant] })).toBe(false)
  })
})
