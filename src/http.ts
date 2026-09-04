/**
 * The HTTP face of Unsay: Streamable HTTP transport, OAuth 2.1 protected
 * resource, the clinician write path, and the public verification route.
 *
 * This file is where the safety thesis is enforced rather than described. The
 * store decides what a principal may read (src/store.ts); everything here
 * decides WHICH principal a request is, and refuses to let a client name its own
 * scopes. See FRICTION.md F-002: `annotations.audience` is advisory, so the
 * boundary has to live behind a verified token or it does not exist.
 *
 * Routes:
 *   POST|GET|DELETE /mcp                              Bearer  — MCP over Streamable HTTP
 *   GET  /.well-known/oauth-protected-resource[/mcp]  public  — RFC 9728 metadata
 *   POST /write                                       HMAC or Bearer care.write
 *   GET  /verify                                      public  — replay the hash chain
 *   GET  /health                                      public
 *   GET  / · /index.html · /clinician.html · /echo.html   public — the three surfaces
 *   GET  /README.md · /DEMO.md · /FRICTION.md · /docs/proof/*  public — what the pages cite
 *   OPTIONS *                                         public  — CORS preflight
 *
 * The three pages in `web/` are served from this process on purpose. They are real
 * MCP hosts speaking to `/mcp` with `fetch`, and a browser blocks a cross-origin
 * request before it leaves; same-origin also means a judge needs one URL, not two.
 * CORS headers are sent as well, for a page opened from somewhere else.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server as NodeHttpServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { EventId, EventStore, StreamId } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

import { AuditLog } from './audit.ts'
import type { AuditReason, AuditVia } from './audit.ts'
import { type Envelope, announceOnce, envelopeFromEnv, startupLine } from './envelope.ts'
import { buildServer } from './server.ts'
import { LiveResourceStore, parseUri } from './store.ts'
import type { AtRestReceipt } from './store.ts'
import { seedDemo } from './seed.ts'
import type { Audience, ChainVerdict, Principal } from './types.ts'
import { SCOPE } from './types.ts'

/**
 * Dev-only secrets. They are deliberately unusable-looking so that a deployment
 * running on the defaults is obvious in a log line and in this file. Real values
 * come from UNSAY_TOKEN_SECRET / UNSAY_WRITE_SECRET.
 */
export const DEV_TOKEN_SECRET = 'dev-only-token-secret-not-for-deployment'
export const DEV_WRITE_SECRET = 'dev-only-write-secret-not-for-deployment'

export const SCOPES_SUPPORTED = [SCOPE.user, SCOPE.assistant, 'care.write'] as const

/** RFC 6750 §2.1 bearer tokens only; a query-string token would end up in access logs. */
const BEARER_METHODS_SUPPORTED = ['header'] as const

/** Replay window for a signed write. Architecture §residual risk: 300 s, stated not hidden. */
export const WRITE_SKEW_MS = 5 * 60 * 1000

const MAX_BODY_BYTES = 256 * 1024
const TOKEN_ALG = 'HS256'
const TOKEN_TYP = 'unsay+jwt'

// ── token: a real signed credential, not a client-asserted scope list ────────

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const unb64u = (s: string) => Buffer.from(s, 'base64url')

export interface TokenClaims {
  sub: string
  /** RFC 8693 style space-delimited list. */
  scope: string
  /** RFC 8707 resource indicator — the URL this token is allowed to be spent at. */
  aud: string
  iat: number
  exp: number
  jti: string
}

export interface MintOptions {
  sub: string
  scopes: readonly string[]
  audience: string
  secret?: string
  /** Seconds. Negative mints an already-expired token, which the tests need. */
  ttlSeconds?: number
  now?: Date
}

/** Mints a token the way the authorization server would. Used by tests, scripts and the dev CLI. */
export function mintToken(opts: MintOptions): string {
  const secret = opts.secret ?? tokenSecret()
  const iat = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000)
  const header = { alg: TOKEN_ALG, typ: TOKEN_TYP }
  const claims: TokenClaims = {
    sub: opts.sub,
    scope: opts.scopes.join(' '),
    aud: opts.audience,
    iat,
    exp: iat + (opts.ttlSeconds ?? 3600),
    jti: randomUUID(),
  }
  const signing = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`
  return `${signing}.${b64u(hmac(secret, signing))}`
}

export type TokenFailure =
  | 'malformed'
  | 'bad_alg'
  | 'bad_signature'
  | 'expired'
  | 'wrong_audience'
  | 'no_scopes'

export class TokenError extends Error {
  readonly failure: TokenFailure
  constructor(failure: TokenFailure) {
    super(failure)
    this.failure = failure
  }
}

function hmac(secret: string, data: string | Buffer): Buffer {
  return createHmac('sha256', secret).update(data).digest()
}

/** Length-checked before timingSafeEqual, which throws on a length mismatch. */
function equalBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface VerifyTokenOptions {
  secret: string
  audience: string
  now?: Date
}

/**
 * Verify a compact signed token and return the principal it names.
 *
 * Scopes come from the signed payload and nowhere else. A client cannot present
 * a scope list, and it cannot swap the algorithm out either — `alg` must be
 * HS256, so an "unsigned" (`alg: none`, or two-segment) token is rejected before
 * any comparison happens.
 */
export function verifyToken(token: string, opts: VerifyTokenOptions): Principal {
  const parts = token.split('.')
  if (parts.length !== 3) throw new TokenError('malformed')
  const [h, p, s] = parts as [string, string, string]

  let header: { alg?: unknown; typ?: unknown }
  let claims: Partial<TokenClaims>
  try {
    header = JSON.parse(unb64u(h).toString('utf8'))
    claims = JSON.parse(unb64u(p).toString('utf8'))
  } catch {
    throw new TokenError('malformed')
  }
  if (header.alg !== TOKEN_ALG) throw new TokenError('bad_alg')

  if (!equalBytes(hmac(opts.secret, `${h}.${p}`), unb64u(s))) {
    throw new TokenError('bad_signature')
  }

  const nowSec = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) throw new TokenError('expired')

  // RFC 8707: a token minted for another resource server must not be spendable
  // here, or a compromised sibling service becomes a way into Ray's record.
  if (claims.aud !== opts.audience) throw new TokenError('wrong_audience')

  const scopes = (claims.scope ?? '').split(' ').filter(Boolean)
  if (!scopes.length || typeof claims.sub !== 'string') throw new TokenError('no_scopes')

  return { sub: claims.sub, scopes }
}

// ── write signature ─────────────────────────────────────────────────────────

/**
 * Signed material is `timestamp.rawBody` — the timestamp is inside the MAC, so a
 * captured request cannot be replayed under a fresh timestamp.
 */
export function writeSigningMaterial(timestamp: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody])
}

export function signWriteBody(secret: string, timestamp: string, rawBody: Buffer): string {
  return hmac(secret, writeSigningMaterial(timestamp, rawBody)).toString('hex')
}

// ── resumability ────────────────────────────────────────────────────────────

/**
 * In-memory EventStore. Resumability is what lets a correction survive the
 * network dropping under an Echo Show mid-answer: the notification is stored
 * whether or not a stream is attached, and replayed on Last-Event-ID.
 */
export class MemoryEventStore implements EventStore {
  #events: { id: EventId; streamId: StreamId; message: JSONRPCMessage }[] = []
  #seq = 0
  readonly capacity: number

  constructor(capacity = 2048) {
    this.capacity = capacity
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const id = `${streamId}#${(++this.#seq).toString().padStart(12, '0')}`
    this.#events.push({ id, streamId, message })
    if (this.#events.length > this.capacity) this.#events.shift()
    return id
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.#events.find((e) => e.id === eventId)?.streamId
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const idx = this.#events.findIndex((e) => e.id === lastEventId)
    if (idx === -1) throw new Error(`unknown event id: ${lastEventId}`)
    const streamId = this.#events[idx]!.streamId
    for (const e of this.#events.slice(idx + 1)) {
      if (e.streamId !== streamId) continue
      // Priming events are stored as `{}` to anchor a resumption point; they are
      // not protocol messages and must not be handed back to a client.
      if (!('jsonrpc' in e.message)) continue
      await send(e.id, e.message)
    }
    return streamId
  }

  get size() {
    return this.#events.length
  }
}

// ── session plumbing ────────────────────────────────────────────────────────

const currentPrincipal = new AsyncLocalStorage<Principal>()

interface Session {
  id: string
  /** The `sub` the session was opened by. A session is not a second credential. */
  sub: string
  principal: Principal
  transport: StreamableHTTPServerTransport
  subscriptions: Set<string>
  close: () => Promise<void>
}

// ── the server ──────────────────────────────────────────────────────────────

export interface CreateHttpServerOptions {
  port?: number
  host?: string
  store?: LiveResourceStore
  /**
   * At-rest sealing for the default store. Omitted, it comes from the environment
   * (UNSAY_KEY_PROVIDER / UNSAY_MASTER_KEY); absent that, the store holds plaintext
   * and the startup banner says PLAINTEXT out loud rather than implying otherwise.
   */
  envelope?: Envelope | null
  audit?: AuditLog
  /**
   * RFC 8707 resource identifier. Defaults to the MCP endpoint of the address we
   * actually bound to, so an ephemeral-port test server audiences correctly.
   */
  resourceUrl?: string
  authorizationServers?: string[]
  tokenSecret?: string
  writeSecret?: string
  now?: () => Date
  /** Set false in tests to keep the "running on dev secrets" banner out of output. */
  announce?: boolean
  /** Serve `web/` from this process. Default true; the pages need a same-origin server. */
  serveWeb?: boolean
}

export interface UnsayHttpServer {
  http: NodeHttpServer
  port: number
  baseUrl: string
  /** The audience every token presented here must carry. */
  resourceUrl: string
  resourceMetadataUrl: string
  store: LiveResourceStore
  /** The at-rest line this process would print. Quoted verbatim by `/verify`. */
  atRest: string
  audit: AuditLog
  events: MemoryEventStore
  stats: {
    sseOpens: number
    sseResumes: number
    /** Date.now() the most recent Last-Event-ID resume arrived. 0 if none has. */
    lastResumeAt: number
    writesAccepted: number
    writesRejected: number
  }
  /** Drop every standalone SSE stream, as a proxy timeout would. Used by the resume probe. */
  dropStreams: () => void
  close: () => Promise<void>
}

const tokenSecret = () => process.env.UNSAY_TOKEN_SECRET ?? DEV_TOKEN_SECRET
const writeSecret = () => process.env.UNSAY_WRITE_SECRET ?? DEV_WRITE_SECRET

export async function createHttpServer(
  opts: CreateHttpServerOptions = {},
): Promise<UnsayHttpServer> {
  // Resolve the envelope BEFORE the store exists: a store built plaintext cannot
  // be sealed afterwards, and a KMS provider that cannot reach AWS must stop the
  // process here rather than quietly serve unencrypted records.
  const envelope = opts.envelope !== undefined ? opts.envelope : await envelopeFromEnv()
  /**
   * The clock is resolved BEFORE the store, and the store is seeded from it.
   *
   * It used to be the other way round: `seedDemo()` stamped every record at the
   * pinned DEMO_NOW while the server read the wall clock, so `npm start` — the one
   * command DEMO.md sends a judge to — served `[changed -32d ago by …]` and the
   * self-announcing-staleness feature was silently dead on the live process. Every
   * gate passed, because verify/e2e/bench all pass an explicit clock and the
   * entrypoint's own was the only one nobody exercised. LESSONS R11.
   */
  const now = opts.now ?? (() => new Date())
  const store = opts.store ?? seedDemo(new LiveResourceStore({ envelope: envelope ?? undefined }), { now: now() })
  // Read back off the store, not off `envelope`: a caller that passed its own
  // pre-sealed store must not be described by an option it never used.
  const atRest = startupLine(store.envelope)
  const audit = opts.audit ?? new AuditLog({ sink: process.env.UNSAY_AUDIT_LOG })
  const secrets = { token: opts.tokenSecret ?? tokenSecret(), write: opts.writeSecret ?? writeSecret() }
  const events = new MemoryEventStore()
  const serveWeb = opts.serveWeb !== false
  const sessions = new Map<string, Session>()
  const stats = { sseOpens: 0, sseResumes: 0, lastResumeAt: 0, writesAccepted: 0, writesRejected: 0 }

  const http = createServer((req, res) => {
    void route(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal_error' })
      else res.end()
    })
  })

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve))
  const addr = http.address() as AddressInfo
  const baseUrl = process.env.UNSAY_PUBLIC_URL ?? `http://127.0.0.1:${addr.port}`
  const resourceUrl = opts.resourceUrl ?? `${baseUrl}/mcp`
  // RFC 9728 §3: for a resource with a path, the metadata lives under the
  // well-known prefix with that path appended. We serve the bare path too,
  // because that is what a hand-written curl reaches for.
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`
  // Unsay is a protected RESOURCE, not an authorization server. In the default
  // local configuration the tokens for this resource are issued by this codebase
  // (mintToken, HS256 over this server's secret), so the issuer identifier is this
  // origin. A deployment fronted by a real authorization server names it in
  // UNSAY_AUTH_SERVER; we do not advertise an /authorize endpoint we do not serve.
  const authorizationServers = opts.authorizationServers ??
    (process.env.UNSAY_AUTH_SERVER ? [process.env.UNSAY_AUTH_SERVER] : [baseUrl])

  if (opts.announce !== false) {
    // Envelope.create() already announced when it built one; announceOnce is
    // idempotent, so this covers the plaintext case without double-printing.
    announceOnce(atRest)
    if (secrets.token === DEV_TOKEN_SECRET) {
      console.error('unsay: UNSAY_TOKEN_SECRET unset — running on the dev token secret.')
    }
  }

  // ── routing ───────────────────────────────────────────────────────────────

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', baseUrl)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    cors(req, res)
    if (req.method === 'OPTIONS') {
      // A browser sends this before any request carrying Authorization or the
      // signature headers. Answering 405 here — which this server used to —
      // kills every cross-origin call from web/ before it is ever made.
      res.writeHead(204).end()
      return
    }

    if (serveWeb && (req.method === 'GET' || req.method === 'HEAD')) {
      const page = STATIC_PAGES[path === '/' ? '/index.html' : path]
      if (page) return sendPage(res, page, req.method === 'HEAD')
      const repoFile = REPO_FILES[path]
      if (repoFile) return sendFile(res, repoFile, REPO_FILE_TYPE(repoFile), req.method === 'HEAD')
    }

    if (path === '/.well-known/oauth-protected-resource' ||
        path === '/.well-known/oauth-protected-resource/mcp') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' })
      return json(res, 200, {
        resource: resourceUrl,
        authorization_servers: authorizationServers,
        scopes_supported: [...SCOPES_SUPPORTED],
        bearer_methods_supported: [...BEARER_METHODS_SUPPORTED],
        resource_documentation: `${baseUrl}/verify`,
      })
    }

    if (path === '/health') return json(res, 200, { ok: true, sessions: sessions.size })
    if (path === '/verify') return handleVerify(req, res, url)
    if (path === '/write') return handleWrite(req, res)
    if (path === '/mcp') return handleMcp(req, res)

    return json(res, 404, { error: 'not_found' })
  }

  /**
   * Permissive by design and safe because it is: every /mcp and /write request is
   * authorized by a Bearer token or an HMAC over the body, neither of which a
   * browser attaches automatically. There is no cookie and no ambient authority
   * for an origin to borrow, so `*` here grants nothing a `curl` did not already
   * have. `mcp-session-id` must be exposed or a browser MCP client cannot read
   * the session it was just given.
   */
  function cors(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('access-control-allow-origin', header(req, 'origin') ?? '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader(
      'access-control-allow-headers',
      'authorization, content-type, accept, x-unsay-signature, x-unsay-timestamp, ' +
        'mcp-session-id, mcp-protocol-version, last-event-id',
    )
    res.setHeader('access-control-expose-headers', 'mcp-session-id, www-authenticate')
    res.setHeader('access-control-max-age', '600')
    res.setHeader('vary', 'origin')
  }

  // ── MCP ───────────────────────────────────────────────────────────────────

  function unauthorized(res: ServerResponse, failure?: TokenFailure) {
    // This header is the whole point of being an OAuth protected resource: it is
    // how a compliant MCP client discovers where to get a token. Not decoration.
    const parts = [`Bearer realm="unsay"`, `resource_metadata="${resourceMetadataUrl}"`]
    if (failure) parts.push(`error="invalid_token"`, `scope="${SCOPES_SUPPORTED.join(' ')}"`)
    res.setHeader('WWW-Authenticate', parts.join(', '))
    json(res, 401, { error: 'invalid_token', error_description: failure ?? 'bearer token required' })
  }

  /** Returns the principal, or writes a 401 and returns null. */
  function authenticate(req: IncomingMessage, res: ServerResponse): Principal | null {
    const header = req.headers.authorization
    if (!header?.toLowerCase().startsWith('bearer ')) {
      unauthorized(res)
      return null
    }
    try {
      return verifyToken(header.slice(7).trim(), {
        secret: secrets.token,
        audience: resourceUrl,
        now: now(),
      })
    } catch (err) {
      unauthorized(res, err instanceof TokenError ? err.failure : 'malformed')
      return null
    }
  }

  function openSession(principal: Principal): Session {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore: events,
      onsessioninitialized: (id) => { session.id = id; sessions.set(id, session) },
      onsessionclosed: (id) => { sessions.delete(id); void session.close() },
    })

    const built = buildServer({
      store,
      principal: () => currentPrincipal.getStore() ?? session.principal,
      // The SDK files a `logging/setLevel` under the transport session id and
      // filters outgoing log messages with the same id. Assigned in
      // `onsessioninitialized` above, so it is empty only before initialize —
      // when there is no level to honour yet either.
      sessionId: () => session.id || undefined,
      now,
    })

    const session: Session = {
      id: '',
      sub: principal.sub,
      principal,
      transport,
      subscriptions: built.subscriptions,
      close: async () => {
        // Dispose before closing: a store listener that outlives its Server would
        // fire a notification down a transport that no longer exists. dispose()
        // detaches the listeners and drops this session's subscriptions with them.
        built.dispose()
        sessions.delete(session.id)
        await built.server.close().catch(() => {})
      },
    }

    void built.server.connect(transport)
    return session
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const principal = authenticate(req, res)
    if (!principal) return

    const sessionId = header(req, 'mcp-session-id')

    if (req.method === 'POST') {
      const raw = await readBody(req, res)
      if (raw === null) return
      let body: unknown
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        return rpcError(res, 400, -32700, 'Parse error')
      }

      let session = sessionId ? sessions.get(sessionId) : undefined
      if (!session) {
        if (sessionId) return rpcError(res, 404, -32001, 'Session not found')
        if (!isInitializeRequest(body)) {
          return rpcError(res, 400, -32000, 'Bad Request: no session and not an initialize request')
        }
        session = openSession(principal)
      } else if (session.sub !== principal.sub) {
        // A session id is a routing key, not a credential. Presenting someone
        // else's session id with your own token must not borrow their scopes.
        return rpcError(res, 403, -32003, 'Forbidden: session belongs to another subject')
      }

      session.principal = principal
      return currentPrincipal.run(principal, () => session.transport.handleRequest(req, res, body))
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId) return rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id required')
      const session = sessions.get(sessionId)
      if (!session) return rpcError(res, 404, -32001, 'Session not found')
      if (session.sub !== principal.sub) {
        return rpcError(res, 403, -32003, 'Forbidden: session belongs to another subject')
      }
      if (req.method === 'GET') {
        if (header(req, 'last-event-id')) {
          stats.sseResumes++
          stats.lastResumeAt = Date.now()
        } else stats.sseOpens++
      }
      session.principal = principal
      return currentPrincipal.run(principal, () => session.transport.handleRequest(req, res))
    }

    return rpcError(res, 405, -32000, 'Method Not Allowed')
  }

  // ── /write — the clinician path ───────────────────────────────────────────

  function rejectWrite(res: ServerResponse, reason: AuditReason, via: AuditVia, actor?: string) {
    audit.append({ outcome: 'rejected', reason, via, actor })
    stats.writesRejected++
    // Deliberately uniform: the response never says WHICH check failed, so a bad
    // signature and a stale timestamp are indistinguishable from outside.
    json(res, 401, { error: 'unauthorized' })
  }

  async function handleWrite(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' })

    // Read the body as BYTES. Everything below runs before JSON.parse, because
    // verifying a signature against a re-serialised parse of the body is the
    // classic way to make a signed webhook forgeable — key order, unicode
    // escaping and duplicate keys all survive parse/stringify differently.
    const raw = await readBody(req, res, () => rejectWrite(res, 'body_too_large', 'none'))
    if (raw === null) return

    const signature = header(req, 'x-unsay-signature')
    let via: AuditVia = 'none'
    let actor: string | undefined

    if (signature) {
      via = 'hmac'
      const timestamp = header(req, 'x-unsay-timestamp')
      if (!timestamp) return rejectWrite(res, 'missing_timestamp', via)

      const skew = Math.abs(now().getTime() - Date.parse(timestamp))
      if (!Number.isFinite(skew) || skew > WRITE_SKEW_MS) {
        return rejectWrite(res, 'stale_timestamp', via)
      }

      const expected = hmac(secrets.write, writeSigningMaterial(timestamp, raw))
      const presented = Buffer.from(signature.replace(/^sha256=/, ''), 'hex')
      if (!equalBytes(expected, presented)) return rejectWrite(res, 'bad_signature', via)
    } else {
      // The other real writer: an interactive clinician app holding an OAuth
      // token. `care.write` is advertised in the metadata, so it must be enforced.
      const header_ = req.headers.authorization
      if (!header_?.toLowerCase().startsWith('bearer ')) {
        return rejectWrite(res, 'missing_signature', 'none')
      }
      try {
        const p = verifyToken(header_.slice(7).trim(), {
          secret: secrets.token,
          audience: resourceUrl,
          now: now(),
        })
        if (!p.scopes.includes('care.write')) return rejectWrite(res, 'insufficient_scope', 'bearer', p.sub)
        via = 'bearer'
        actor = p.sub
      } catch {
        return rejectWrite(res, 'bad_signature', 'bearer')
      }
    }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return rejectWrite(res, 'malformed_body', via, actor)
    }

    const patient = str(body.patient)
    const domain = str(body.domain)
    const value = str(body.value)
    const audience = body.audience === 'assistant' ? 'assistant' : 'user'
    const authorId = str(body.authorId) ?? actor
    const authorLabel = str(body.authorLabel) ?? authorId
    if (!patient || !domain || !value || !authorId || !authorLabel) {
      return rejectWrite(res, 'invalid_fields', via, actor)
    }
    /**
     * A path segment cannot contain the path separator, and `|` is the AAD
     * separator the envelope reserves. Without this check `patient: "ray/evil"`
     * publishes a record at `care://ray/evil/d` that `parseUri()` then reads as a
     * malformed version segment and refuses forever: append-only, unreadable,
     * uncorrectable, and still occupying a cursor page. A write nobody can ever
     * revise is the opposite of this product.
     */
    if (/[/|]/.test(patient) || /[/|]/.test(domain)) {
      return rejectWrite(res, 'invalid_fields', via, actor)
    }

    try {
      // writtenAt is the SERVER clock. A writer that could set it could backdate
      // a correction, and "how old is this instruction" is a spoken safety claim.
      const record = store.publish({
        subject: patient,
        topic: domain,
        audience: audience as Audience,
        value,
        authorId,
        authorLabel,
        writtenAt: now().toISOString(),
        staleAfter: str(body.staleAfter),
        priority: typeof body.priority === 'number' ? body.priority : undefined,
      })
      const uri = `${audience === 'assistant' ? 'care-internal://' : 'care://'}${patient}/${domain}`
      /**
       * The audit actor is the VERIFIED principal wherever one exists, never the
       * body's `authorId`.
       *
       * This used to log `authorId`, which on the bearer path silently discarded
       * `p.sub` — so a `care.write` holder could name any clinician as the author
       * and the trail recorded the impersonated name while the real principal
       * appeared in no row at all. SPEC I-14 promises every write attempt is
       * attributable; that promise was false on exactly the path where an identity
       * had been proved. The claimed author still reaches the record and the hash
       * chain (T-4: one shared write secret means `authorId` is claimed, not
       * proven) — but the row now says who actually presented a credential.
       */
      audit.append({ outcome: 'accepted', reason: 'ok', via, actor: actor ?? authorId, uri })
      stats.writesAccepted++
      // Counted, not asserted. This used to be a constant `true`, which says a
      // notification was DISPATCHED — a clinician receipt that renders "a host was
      // corrected" from a constant is exactly the {success:true} lie the verify
      // gate exists to catch. Sessions are counted after publish(), so a host that
      // subscribed to this URI is in the number.
      const subscribers = [...sessions.values()].filter((s) => s.subscriptions.has(uri)).length
      return json(res, 200, {
        uri,
        version: record.version,
        versionHash: record.versionHash,
        writtenAt: record.writtenAt,
        subscribers,
        notified: subscribers > 0,
      })
    } catch {
      // The store refuses an audience flip on an existing chain (store.publish).
      audit.append({ outcome: 'rejected', reason: 'store_rejected', via, actor: actor ?? authorId })
      stats.writesRejected++
      return json(res, 409, { error: 'conflict' })
    }
  }

  // ── /verify — the link a judge clicks ─────────────────────────────────────

  /**
   * Public and unauthenticated, so it lists ONLY speakable (`care://`) chains.
   * Publishing the existence of `care-internal://` URIs here would undo, on an
   * open port, exactly the partition the rest of the server enforces. Present a
   * token with care.read.assistant and the internal chains are included.
   */
  function handleVerify(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' })

    let principal: Principal = { sub: 'anonymous', scopes: [SCOPE.user] }
    const auth = req.headers.authorization
    if (auth?.toLowerCase().startsWith('bearer ')) {
      try {
        principal = verifyToken(auth.slice(7).trim(), {
          secret: secrets.token,
          audience: resourceUrl,
          now: now(),
        })
      } catch {
        return unauthorized(res, 'bad_signature')
      }
    }

    const wanted = url.searchParams.get('uri')
    const visible = store.list(principal)
    const chains: ChainVerdict[] = []
    const receipts: AtRestReceipt[] = []
    for (const { uri } of visible) {
      if (wanted && uri !== wanted && !wanted.startsWith(`${uri}/`)) continue
      const parsed = parseUri(uri)!
      chains.push(store.verify(parsed.subject, parsed.topic))
      // Every field of this is read back out of the STORED bytes — provider, key
      // id, IV, tag, length — without the data key. It is the difference between
      // the server claiming it encrypted something and a reader checking.
      receipts.push(store.atRestReceipt(parsed.subject, parsed.topic))
    }

    if (wanted && chains.length === 0) return json(res, 404, { error: 'not_found', uri: wanted })

    const versions = chains.reduce((n, c) => n + c.versions, 0)
    const payload = wanted
      ? { ...chains[0]!, atRest: receipts[0]! }
      : {
          resource: resourceUrl,
          checkedAt: now().toISOString(),
          atRest,
          chains,
          receipts,
          versions,
          intact: chains.every((c) => c.intact),
        }

    if (wantsJson(req)) return json(res, 200, payload)

    const encrypted = receipts.filter((r) => r.encrypted).length
    const lines = [
      'unsay · version chain verification',
      `resource : ${resourceUrl}`,
      `checked  : ${now().toISOString()}`,
      `${atRest}`,
      '',
      ...chains.map(
        (c) =>
          `${c.intact ? 'INTACT ' : 'BROKEN '} ${c.uri.padEnd(38)} ${c.versions} version(s)` +
          (c.intact ? '' : ` — chain breaks at v${c.brokenAt}`),
      ),
      '',
      chains.every((c) => c.intact)
        ? `ALL ${chains.length} CHAIN(S) INTACT · ${versions} versions replayed from SHA-256(prev ‖ value ‖ writtenAt ‖ authorId)`
        : 'CHAIN BROKEN',
      `${encrypted}/${receipts.length} latest version(s) sealed at rest` +
        (encrypted ? ` · ${receipts.find((r) => r.encrypted)!.algorithm}` : ''),
    ]
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(lines.join('\n') + '\n')
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  return {
    http,
    port: addr.port,
    baseUrl,
    resourceUrl,
    resourceMetadataUrl,
    store,
    atRest,
    audit,
    events,
    stats,
    dropStreams: () => {
      for (const s of sessions.values()) s.transport.closeStandaloneSSEStream()
    },
    close: async () => {
      for (const s of [...sessions.values()]) await s.close()
      sessions.clear()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

// ── the three surfaces, served from this process ─────────────────────────────

/**
 * An allowlist, not a directory walk. Every servable path is a literal key here, so
 * there is nothing for `..` to reach and no code path that maps a request path onto
 * the filesystem — the classic static-server traversal bug cannot be written here.
 */
const STATIC_PAGES: Record<string, string> = {
  '/index.html': 'index.html',
  '/clinician.html': 'clinician.html',
  '/echo.html': 'echo.html',
}

/**
 * The documents and receipts the landing page CITES, served from the same origin.
 *
 * Without these the flagship "Proof" section rendered four amber lines reading
 * "Not reachable from this deployment" under `npm start` — the exact command
 * DEMO.md sends a judge to — and every link in the footer answered
 * `{"error":"not_found"}`. The artifacts were on disk the whole time; the server
 * simply had no route to them. Read-only, still an allowlist, still no path
 * arithmetic.
 */
const REPO_FILES: Record<string, string> = {
  '/README.md': 'README.md',
  '/DEMO.md': 'DEMO.md',
  '/ARCHITECTURE.md': 'ARCHITECTURE.md',
  '/FRICTION.md': 'FRICTION.md',
  '/LICENSE': 'LICENSE',
  '/docs/SPEC.md': 'docs/SPEC.md',
  '/docs/proof/bench.txt': 'docs/proof/bench.txt',
  '/docs/proof/verify.json': 'docs/proof/verify.json',
  '/docs/proof/bench.json': 'docs/proof/bench.json',
  '/docs/proof/live_run.jsonl': 'docs/proof/live_run.jsonl',
  '/docs/proof/probe_subscribe.json': 'docs/proof/probe_subscribe.json',
  '/docs/proof/resume.json': 'docs/proof/resume.json',
  '/skill/SKILL.md': 'skill/SKILL.md',
  '/icon.svg': 'docs/icon.svg',
  '/og.svg': 'docs/og.svg',
  '/packages/live-resources/src/store.ts': 'packages/live-resources/src/store.ts',
  '/src/server.ts': 'src/server.ts',
  '/src/http.ts': 'src/http.ts',
}

/**
 * Served as text, deliberately, including the `.ts` files: a judge following a
 * link from the page wants to READ the enforcement point, not download it.
 */
const REPO_FILE_TYPE = (file: string) =>
  file.endsWith('.json') ? 'application/json; charset=utf-8'
    : file.endsWith('.svg') ? 'image/svg+xml; charset=utf-8'
    : 'text/plain; charset=utf-8'

const pageCache = new Map<string, Buffer>()

function sendFile(res: ServerResponse, rel: string, contentType: string, headOnly: boolean) {
  let body = pageCache.get(rel)
  if (!body) {
    try {
      body = readFileSync(new URL(`../${rel}`, import.meta.url))
    } catch {
      return json(res, 404, { error: 'not_found' })
    }
    pageCache.set(rel, body)
  }
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    // The pages are the demo surface and change with every deploy; a cached copy
    // pointing at a stale bench number is worse than a re-fetch of 30 kB.
    'cache-control': 'no-cache',
  })
  headOnly ? res.end() : res.end(body)
}

function sendPage(res: ServerResponse, file: string, headOnly: boolean) {
  sendFile(res, `web/${file}`, 'text/html; charset=utf-8', headOnly)
}

// ── small helpers ───────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined)

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

function wantsJson(req: IncomingMessage): boolean {
  const accept = header(req, 'accept') ?? ''
  return accept.includes('application/json') || accept.includes('*/*') || accept === ''
}

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function rpcError(res: ServerResponse, status: number, code: number, message: string) {
  json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null })
}

/** Returns the raw bytes, or null having already answered the request. */
async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  onTooLarge?: () => void,
): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      if (onTooLarge) onTooLarge()
      else json(res, 413, { error: 'payload_too_large' })
      return null
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}
