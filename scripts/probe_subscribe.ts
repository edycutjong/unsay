/**
 * Day-1 probe — does the correction mechanism exist at all?
 *
 * Unsay's entire thesis is that a resource can be revised while an assistant is
 * mid-answer and the assistant hears about it in time to retract. Everything else
 * in the product is downstream of one question:
 *
 *   Does a client subscribed to a resource over Streamable HTTP actually receive
 *   notifications/resources/updated when the server revises it, and how fast?
 *
 * LESSONS R1: verify the sponsor SDK in a script FIRST, with real responses,
 * before wrapping anything in UI. If this probe fails, the product does not exist
 * and we find out on day 1 rather than in week 5.
 *
 * Run: npm run probe
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'

const URI = 'care://ray/weight_bearing'
const PORT = 39_517

// --- the resource, and its one revision -------------------------------------
let plan = {
  value: 'Partial weight-bearing, about half your body weight through the operated leg.',
  author: 'Mr Adeyemi, surgical team',
  lastModified: '2026-08-31T09:00:00Z',
}
const revision = {
  value: 'Full weight-bearing as tolerated.',
  author: 'Sarah Okafor, physio',
  lastModified: new Date().toISOString(),
}

const subscribers = new Set<string>()

// --- server -----------------------------------------------------------------
const server = new Server(
  { name: 'unsay-probe', version: '0.1.0' },
  { capabilities: { resources: { subscribe: true, listChanged: true } } },
)

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: URI,
      name: 'Weight bearing status',
      mimeType: 'text/plain',
      annotations: { audience: ['user'], priority: 0.9, lastModified: plan.lastModified },
    },
  ],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
  contents: [
    {
      uri: req.params.uri,
      mimeType: 'text/plain',
      text: plan.value,
      annotations: { audience: ['user'], priority: 0.9, lastModified: plan.lastModified },
    },
  ],
}))

server.setRequestHandler(SubscribeRequestSchema, async (req) => {
  subscribers.add(req.params.uri)
  return {}
})
server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
  subscribers.delete(req.params.uri)
  return {}
})

// --- HTTP plumbing ----------------------------------------------------------
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
await server.connect(transport)

const http = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    let parsed: unknown = undefined
    if (raw.length) { try { parsed = JSON.parse(raw.toString('utf8')) } catch { /* SSE GET */ } }
    transport.handleRequest(req, res, parsed)
  })
})
await new Promise<void>((r) => http.listen(PORT, r))

// --- client -----------------------------------------------------------------
const client = new Client({ name: 'unsay-probe-client', version: '0.1.0' }, { capabilities: {} })

let received: { at: number; uri: string } | null = null
let resolveGot: (v: unknown) => void
const got = new Promise((r) => { resolveGot = r })

client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
  received = { at: performance.now(), uri: n.params.uri }
  resolveGot(n)
})

await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))

const log = (s: string) => console.log(s)
log('unsay · day-1 probe · Streamable HTTP\n')

// 1. what did the server actually negotiate?
const caps = client.getServerCapabilities()
log(`  server capabilities.resources : ${JSON.stringify(caps?.resources)}`)
const subscribeSupported = caps?.resources?.subscribe === true
log(`  subscribe supported           : ${subscribeSupported ? 'YES' : 'NO'}`)

// 2. read the pre-revision value
const before = await client.readResource({ uri: URI })
log(`  read (before)                 : "${(before.contents[0] as { text: string }).text.slice(0, 46)}…"`)

// 3. subscribe
await client.subscribeResource({ uri: URI })
log(`  subscribed                    : ${URI}`)

// 4. revise — the physio writes — and fire the notification
const t0 = performance.now()
plan = revision
await server.sendResourceUpdated({ uri: URI })

// 5. did it arrive, and how fast?
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('no notification in 5s')), 5000))
await Promise.race([got, timeout])
const latencyMs = received!.at - t0

// 6. does a re-read return the NEW value?
const after = await client.readResource({ uri: URI })
const newText = (after.contents[0] as { text: string }).text

log(`\n  notifications/resources/updated RECEIVED`)
log(`    uri                         : ${received!.uri}`)
log(`    write → notification        : ${latencyMs.toFixed(2)} ms`)
log(`    re-read returns new value   : ${newText === revision.value ? 'YES' : 'NO'}`)
log(`    author now                  : ${revision.author}`)

const speechWindowMs = 3400 // a 12-word Alexa sentence
const midSentence = latencyMs < speechWindowMs
log(`\n  VERDICT: correction lands mid-sentence (< ${speechWindowMs} ms): ${midSentence ? 'YES' : 'NO'}`)

// 7. commit the receipt — R5: a real run, on disk, on day 2 not week 6
const proof = {
  probe: 'subscribe_updated_streamable_http',
  ranAt: new Date().toISOString(),
  sdk: '@modelcontextprotocol/sdk@1.30.0',
  transport: 'StreamableHTTP',
  serverCapabilities: caps?.resources ?? null,
  uri: URI,
  notificationReceived: received !== null,
  writeToNotificationMs: Number(latencyMs.toFixed(3)),
  reReadReturnedNewValue: newText === revision.value,
  speechWindowMs,
  landsMidSentence: midSentence,
}
writeFileSync('docs/proof/probe_subscribe.json', JSON.stringify(proof, null, 2) + '\n')
log(`\n  receipt → docs/proof/probe_subscribe.json`)

await client.close()
await server.close()
http.close()
process.exit(received && newText === revision.value && midSentence ? 0 : 1)
