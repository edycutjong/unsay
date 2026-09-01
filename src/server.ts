/**
 * The MCP server. Every surface here is one a judge can call.
 *
 * Surfaces wired (see ../specs/sponsor-defense.md for the full defence):
 *   resources/list · resources/read · resources/subscribe · resources/unsubscribe
 *   resources/templates/list · completion/complete
 *   notifications/resources/updated · notifications/resources/list_changed
 *   annotations: audience · priority · lastModified
 *   tools/list · tools/call  (whats_changed — the fallback path)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { LiveResourceStore, NotFoundError, parseUri, uriFor } from './store.ts'
import { RAY, seed } from './seed.ts'
import type { Principal } from './types.ts'

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

export interface BuildOptions {
  store?: LiveResourceStore
  /** Resolves the principal for a request. Injected so tests can vary scopes. */
  principal: () => Principal
  now?: () => Date
}

export function buildServer(opts: BuildOptions) {
  const store = opts.store ?? seed(new LiveResourceStore())
  const now = opts.now ?? (() => new Date())
  const subscriptions = new Set<string>()

  const server = new Server(
    { name: 'unsay', version: '0.1.0' },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        completions: {},
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  )

  // Any revision fires the notification the whole product depends on.
  store.onUpdated((uri) => {
    if (subscriptions.has(uri)) void server.sendResourceUpdated({ uri })
  })

  // A new domain (the GP adds wound care) changes the list, not a resource.
  let listChangedArmed = false
  store.onListChanged(() => {
    if (listChangedArmed) void server.sendResourceListChanged()
  })
  // Seeding is not a change — arm only once the server is live.
  queueMicrotask(() => { listChangedArmed = true })

  // ── resources/list ─────────────────────────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: store.list(opts.principal()).map(({ record, uri }) => ({
      uri,
      name: `${record.domain.replace(/_/g, ' ')} (v${record.version})`,
      description: `Last changed by ${record.authorLabel}`,
      mimeType: 'text/plain',
      annotations: store.annotationsFor(record),
    })),
  }))

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
    const record = store.read(req.params.uri, opts.principal()) // throws -32002
    const s = store.staleness(req.params.uri, opts.principal(), now())
    const ageDays = Math.floor(s.ageMs / 86_400_000)

    const header = s.stale
      ? `[STALE — last changed ${ageDays} day${ageDays === 1 ? '' : 's'} ago by ${record.authorLabel}; say this age aloud]\n`
      : `[changed ${ageDays === 0 ? 'today' : `${ageDays}d ago`} by ${record.authorLabel}]\n`

    return {
      contents: [
        {
          uri: req.params.uri,
          mimeType: 'text/plain',
          text: header + record.value,
          annotations: store.annotationsFor(record),
        },
      ],
    }
  })

  // ── resources/subscribe · unsubscribe ──────────────────────────────────────
  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    store.read(req.params.uri, opts.principal()) // authorize before subscribing
    subscriptions.add(req.params.uri)
    return {}
  })
  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscriptions.delete(req.params.uri)
    return {}
  })

  // ── completion/complete — {version} resolved via context.arguments ─────────
  server.setRequestHandler(CompleteRequestSchema, async (req) => {
    const ref = req.params.ref
    if (ref.type !== 'ref/resource') return { completion: { values: [], hasMore: false } }

    const argName = req.params.argument.name
    const prefix = req.params.argument.value ?? ''
    const p = opts.principal()

    if (argName === 'patient') {
      return { completion: { values: [RAY].filter((v) => v.startsWith(prefix)), hasMore: false } }
    }

    if (argName === 'domain') {
      const domains = [...new Set(store.list(p).map((x) => parseUri(x.uri)!.domain))]
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
        .filter((r) => p.scopes.includes(`care.read.${r.audience}`))
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
      throw new Error(`Unknown tool: ${req.params.name}`)
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

  return { server, store, subscriptions }
}

export { LiveResourceStore, NotFoundError, uriFor, seed, RAY }
