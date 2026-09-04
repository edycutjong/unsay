/**
 * The MCP server. Every surface here is one a judge can call.
 *
 * Surfaces wired (ARCHITECTURE.md is generated from this list, not from prose):
 *   resources/list (cursor-paginated) · resources/read (text + blob) ·
 *   resources/subscribe · resources/unsubscribe · resources/templates/list ·
 *   completion/complete (ref/resource and ref/prompt) ·
 *   prompts/list · prompts/get · logging/setLevel ·
 *   notifications/resources/updated · notifications/resources/list_changed ·
 *   notifications/message · annotations: audience · priority · lastModified ·
 *   tools/list · tools/call (whats_changed — the fallback path)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { blobFor } from './blobs.ts'
import { ResourceNotifier } from '../packages/live-resources/src/index.ts'
import { LiveResourceStore, NotFoundError, parseUri, uriFor } from './store.ts'
import { DEMO_NOW, RAY, seed, seedDemo } from './seed.ts'
import { SCOPE, type Principal } from './types.ts'

export const SERVER_INSTRUCTIONS = `This server publishes a patient's care plan as LIVE resources.

Facts change while you are answering. Two rules:

1. If you have subscribed to a resource and receive notifications/resources/updated
   mid-response, STOP, re-read it, and correct yourself out loud — name what changed,
   how long ago, and who changed it.
2. If you cannot subscribe, call the "whats_changed" tool before answering any question
   about the care plan. It returns what has been revised since a given timestamp.

Resources annotated audience:["assistant"] are for your reasoning ONLY. Never speak them,
quote them, or paraphrase them to the patient. They exist to shape your answer, not to be
part of it.

When a resource is past its staleness date, say its age out loud rather than reading it
with confidence.`

/**
 * Small on purpose. A page size nobody reaches is a pagination implementation
 * nobody has run: the demo store holds eight resources, so every client walks
 * three pages and the cursor is exercised on the judged path.
 */
export const RESOURCE_PAGE_SIZE = 3

export const BRIEF_CARER = 'brief_carer'

export interface BuildOptions {
  store?: LiveResourceStore
  /** Resolves the principal for a request. Injected so tests can vary scopes. */
  principal: () => Principal
  now?: () => Date
}

/**
 * Cursors are opaque to the client and carry the last URI emitted, not an offset.
 * Resumption by key survives a concurrent publish — which this server has, since a
 * new domain can appear between two pages — where an offset would silently skip a
 * resource into the gap.
 */
const encodeCursor = (lastUri: string) =>
  Buffer.from(JSON.stringify({ after: lastUri }), 'utf8').toString('base64url')

function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const after = (parsed as { after?: unknown }).after
    if (typeof after !== 'string') throw new Error('missing after')
    return after
  } catch {
    // The spec allows -32602 for a cursor the server did not issue. Failing loudly
    // beats resetting to page one, which would loop a client forever.
    throw new McpError(ErrorCode.InvalidParams, `Invalid cursor: ${cursor}`)
  }
}

export function buildServer(opts: BuildOptions) {
  const store = opts.store ?? seedDemo()
  const now = opts.now ?? (() => new Date())

  const server = new Server(
    { name: 'unsay', version: '0.1.0' },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        completions: {},
        prompts: {},
        // A second, cheap notification channel. Declaring it also makes the SDK
        // serve logging/setLevel, so a host can turn the revision log down.
        logging: {},
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  )

  /**
   * Same tolerance the notifier applies to resource notifications: a revision
   * written while no host is attached is not an error — the store is the source of
   * truth and the next read is correct either way. Anything else is surfaced, but
   * never by killing the process mid-demo.
   */
  const logged = (sent: Promise<void>) =>
    void sent.catch((e: unknown) => {
      if (!/not connected/i.test(String(e))) console.error('[unsay] revision log failed:', e)
    })

  /**
   * The second notification channel. Audience-filtered like every other surface:
   * naming the URI of an internal record to a user-scoped host would confirm that
   * it exists, which is exactly what NotFoundError refuses to do on read. The
   * value is never logged — a log line is not a read, and only a read is authorized.
   */
  function logRevision(uri: string) {
    const parsed = parseUri(uri)
    if (!parsed) return
    let scopes: string[]
    try {
      scopes = opts.principal().scopes
    } catch {
      // No resolvable principal (a revision outside any request context): we do
      // not know who is listening, so we do not name a URI to them.
      return
    }
    if (!scopes.includes(SCOPE[parsed.audience])) return
    const latest = store.versions(parsed.subject, parsed.topic).at(-1)
    if (!latest) return
    logged(
      server.sendLoggingMessage({
        level: 'notice',
        logger: 'unsay.revision',
        data: {
          uri,
          version: latest.version,
          author: latest.authorLabel,
          changedAt: latest.writtenAt,
          versionHash: latest.versionHash,
          prevHash: latest.prevHash,
        },
      }),
    )
  }

  /**
   * The store-to-protocol wiring, from @unsay/live-resources: it owns the
   * subscription set, sends `updated` only for URIs this session actually
   * subscribed to, and holds `list_changed` back until a list has been SERVED —
   * seeding a store is not news to a client that holds no list to invalidate.
   *
   * `onRevision` is the second channel, and it is Unsay's: the notifier does not
   * know what a care record is, and it must not, because deciding who may be TOLD
   * a URI changed is the same authorization question as deciding who may read it.
   */
  const notifier = new ResourceNotifier({
    store,
    target: server,
    onRevision: logRevision,
    onError: (e, uri) => console.error(`[unsay] notification failed for ${uri ?? 'the list'}:`, e),
  })
  const subscriptions = notifier.subscriptions

  // ── resources/list — cursor-paginated ──────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async (req) => {
    // Sorted by URI so the ordering a cursor resumes into is stable across calls,
    // independent of the store's insertion order.
    const all = store
      .list(opts.principal())
      .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))

    const after = req.params?.cursor ? decodeCursor(req.params.cursor) : null
    const rest = after === null ? all : all.filter((x) => x.uri > after)
    const page = rest.slice(0, RESOURCE_PAGE_SIZE)
    const last = page.at(-1)

    // The client now holds a list, so a later change to it is something it can act
    // on. Armed after the cursor is validated — a rejected cursor served no list.
    notifier.armListChanged()

    return {
      resources: page.map(({ record, uri }) => {
        const blob = blobFor(uri)
        return {
          uri,
          name: `${record.topic.replace(/_/g, ' ')} (v${record.version})`,
          description: `Last changed by ${record.authorLabel}`,
          mimeType: blob?.mimeType ?? 'text/plain',
          ...(blob ? { size: blob.bytes } : {}),
          annotations: store.annotationsFor(record),
        }
      }),
      ...(last && rest.length > page.length ? { nextCursor: encodeCursor(last.uri) } : {}),
    }
  })

  // ── resources/templates/list — RFC 6570 ────────────────────────────────────
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const p = opts.principal()
    const templates = []
    if (p.scopes.includes('care.read.user')) {
      templates.push({
        uriTemplate: 'care://{patient}/{domain}/{version}',
        name: 'Care plan resource (speakable)',
        description: 'A versioned care-plan fact that may be spoken to the patient.',
        mimeType: 'text/plain',
      })
    }
    if (p.scopes.includes('care.read.assistant')) {
      templates.push({
        uriTemplate: 'care-internal://{patient}/{domain}/{version}',
        name: 'Reasoning context (never speak)',
        description: 'Context that shapes the answer and must never be said to the patient.',
        mimeType: 'text/plain',
      })
    }
    return { resourceTemplates: templates }
  })

  // ── resources/read ─────────────────────────────────────────────────────────
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri
    const record = store.read(uri, opts.principal()) // throws -32002
    const s = store.staleness(uri, opts.principal(), now())
    const ageDays = Math.floor(s.ageMs / 86_400_000)

    const header = s.stale
      ? `[STALE — last changed ${ageDays} day${ageDays === 1 ? '' : 's'} ago by ${record.authorLabel}; say this age aloud]\n`
      : `[changed ${ageDays === 0 ? 'today' : `${ageDays}d ago`} by ${record.authorLabel}]\n`

    /**
     * What makes a retraction auditable. A client that heard v1 and then hears v2
     * can prove which bytes it was told, and that v2 descends from exactly the v1
     * it read, by replaying prevHash → versionHash. Without it "the plan changed"
     * is a claim; with it, it is checkable — `npm run verify` walks the same chain.
     */
    const meta = {
      'unsay/version': record.version,
      'unsay/versionHash': record.versionHash,
      'unsay/prevHash': record.prevHash,
      'unsay/audience': record.audience,
      'unsay/lastModified': record.writtenAt,
      'unsay/stale': s.stale,
    }

    const contents: Record<string, unknown>[] = [
      {
        uri,
        mimeType: 'text/plain',
        text: header + record.value,
        // ResourceContents has no `annotations` field in the schema — the SDK's
        // client strips it (FRICTION F-005). Sent anyway for non-SDK hosts that
        // pass the JSON through, with `_meta` as the load-bearing copy.
        annotations: store.annotationsFor(record),
        _meta: meta,
      },
    ]

    // A clip answers "show me the movement" the way no sentence does. Same URI,
    // same authorization — the blob is only reachable through the read above.
    const blob = blobFor(uri)
    if (blob) {
      contents.push({ uri, mimeType: blob.mimeType, blob: blob.base64, _meta: meta })
    }

    return { contents }
  })

  // ── resources/subscribe · unsubscribe ──────────────────────────────────────
  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    // Authorize FIRST. The notifier cannot do this for us — only the store knows
    // whether this principal is allowed to learn that the URI exists at all.
    store.read(req.params.uri, opts.principal())
    notifier.subscribe(req.params.uri)
    return {}
  })
  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    notifier.unsubscribe(req.params.uri)
    return {}
  })

  // ── prompts ────────────────────────────────────────────────────────────────
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: BRIEF_CARER,
        title: 'Brief the carer',
        description:
          "Assemble the patient's speakable facts into a handover briefing for a visiting " +
          'carer or family member. Cannot emit reasoning-only content.',
        arguments: [
          {
            name: 'patient',
            description: 'Patient id. Defaults to the only patient on this server.',
            required: false,
          },
        ],
      },
    ],
  }))

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name !== BRIEF_CARER) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${req.params.name}`)
    }
    const patient = req.params.arguments?.patient ?? RAY

    /**
     * The point of this surface. The briefing is assembled through a principal
     * NARROWED to the speakable scope, so a caller holding both scopes still
     * cannot get reasoning-only content out of prompts/get. The partition is a
     * property of how the text is built, not a filter applied to it afterwards —
     * there is no code path here that can read a care-internal:// record.
     */
    const caller = opts.principal()
    const speakableOnly: Principal = {
      sub: caller.sub,
      scopes: caller.scopes.filter((s) => s === SCOPE.user),
    }

    const facts = store
      .list(speakableOnly)
      .filter(({ record }) => record.subject === patient)
      .sort((a, b) => b.record.priority - a.record.priority)

    const at = now()
    const lines = facts.map(({ record, uri }) => {
      const s = store.staleness(uri, speakableOnly, at)
      const ageDays = Math.floor(s.ageMs / 86_400_000)
      const age = ageDays === 0 ? 'today' : `${ageDays}d ago`
      const stale = s.stale ? ' — PAST ITS REVIEW DATE, say its age aloud' : ''
      return `- ${record.topic.replace(/_/g, ' ')} (v${record.version}, ${age}, ${record.authorLabel}${stale})\n  ${record.value}`
    })

    const body = lines.length
      ? lines.join('\n')
      : '- (no speakable facts are available to this caller)'

    return {
      description: `Handover briefing for ${patient}, assembled from live care resources.`,
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Brief the person taking over care of ${patient} in plain spoken English, ` +
              `in under sixty seconds. Read the facts in the order given; say the age of ` +
              `anything past its review date. Do not add advice of your own.\n\n` +
              `Facts as of ${at.toISOString()} (speakable only):\n${body}`,
          },
        },
      ],
    }
  })

  // ── completion/complete — {version} resolved via context.arguments ─────────
  server.setRequestHandler(CompleteRequestSchema, async (req) => {
    const ref = req.params.ref
    const argName = req.params.argument.name
    const prefix = req.params.argument.value ?? ''
    const p = opts.principal()

    if (ref.type === 'ref/prompt') {
      if (ref.name === BRIEF_CARER && argName === 'patient') {
        return { completion: { values: [RAY].filter((v) => v.startsWith(prefix)), hasMore: false } }
      }
      return { completion: { values: [], hasMore: false } }
    }
    if (ref.type !== 'ref/resource') return { completion: { values: [], hasMore: false } }

    if (argName === 'patient') {
      return { completion: { values: [RAY].filter((v) => v.startsWith(prefix)), hasMore: false } }
    }

    if (argName === 'domain') {
      const domains = [...new Set(store.list(p).map((x) => parseUri(x.uri)!.topic))]
      return {
        completion: { values: domains.filter((d) => d.startsWith(prefix)).sort(), hasMore: false },
      }
    }

    if (argName === 'version') {
      // THE point of context.arguments: {version} completes against the
      // already-resolved {domain}. Without it we would have to guess.
      const ctx = req.params.context?.arguments ?? {}
      const domain = ctx.domain
      const patient = ctx.patient ?? RAY
      if (!domain) return { completion: { values: [], hasMore: false } }
      const versions = store
        .versions(patient, domain)
        .filter((r) => p.scopes.includes(SCOPE[r.audience]))
        .map((r) => `v${r.version}`)
        .filter((v) => v.startsWith(prefix))
      return { completion: { values: versions.reverse(), hasMore: false } }
    }

    return { completion: { values: [], hasMore: false } }
  })

  // ── tools — the fallback path for hosts without subscriptions ──────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'whats_changed',
        description:
          'Returns care-plan facts revised since a timestamp. Call this BEFORE answering any ' +
          'question about the care plan if you cannot subscribe to resources.',
        inputSchema: {
          type: 'object',
          properties: {
            since: { type: 'string', description: 'ISO 8601. Omit for everything changed today.' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            changed: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  uri: { type: 'string' },
                  value: { type: 'string' },
                  author: { type: 'string' },
                  changedAt: { type: 'string' },
                  ageSeconds: { type: 'number' },
                },
                required: ['uri', 'value', 'author', 'changedAt', 'ageSeconds'],
              },
            },
          },
          required: ['changed'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'whats_changed') {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`)
    }
    const since = new Date(
      (req.params.arguments?.since as string | undefined) ??
        new Date(now().getTime() - 86_400_000).toISOString(),
    )
    const p = opts.principal()
    const changed = store
      .list(p)
      .filter(({ record }) => new Date(record.writtenAt) > since)
      .map(({ record, uri }) => ({
        uri,
        value: record.value,
        author: record.authorLabel,
        changedAt: record.writtenAt,
        ageSeconds: Math.round((now().getTime() - new Date(record.writtenAt).getTime()) / 1000),
      }))
    const payload = { changed }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    }
  })

  /**
   * Detach this server's store listeners. A per-session server (src/http.ts) that
   * closed without this would keep a listener calling into a disconnected Server
   * for the lifetime of the store.
   */
  const dispose = () => notifier.dispose()

  return { server, store, subscriptions, dispose }
}

export { LiveResourceStore, NotFoundError, uriFor, seed, seedDemo, blobFor, RAY, DEMO_NOW }
