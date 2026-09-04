/**
 * Probe — does a correction survive the network dropping under it?
 *
 * The mid-sentence retraction depends on one notification arriving. An Echo Show
 * on domestic wifi loses its SSE stream regularly, and a correction that is only
 * ever pushed is a correction that can be silently lost — the failure mode is a
 * 68-year-old confidently told the old instruction. Streamable HTTP has an answer
 * (`Last-Event-ID` replay); this asserts that ours actually works rather than
 * that we merely configured an event store.
 *
 * Sequence, all over real sockets with a real MCP client:
 *   1. subscribe, write revision A, receive it live      → the client now holds an event id
 *   2. drop the standalone SSE stream, as a proxy timeout would
 *   3. write revision B through POST /write while nothing is listening
 *   4. the client reconnects with Last-Event-ID
 *   5. ASSERT the missed notifications/resources/updated is replayed
 *
 * LESSONS R10: an unexercised seam is a missing feature.
 *
 * Run: node --experimental-strip-types scripts/probe_resume.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

import { DEV_WRITE_SECRET, createHttpServer, mintToken, signWriteBody } from '../src/http.ts'
import { LiveResourceStore, uriFor } from '../src/store.ts'
import { RAY, seedDemo } from '../src/seed.ts'

/** Long enough to finish a write inside it, short enough that the probe stays quick. */
const RECONNECT_DELAY_MS = 800
const WB = uriFor(RAY, 'weight_bearing', 'user')
const WRITE_SECRET = process.env.UNSAY_WRITE_SECRET ?? DEV_WRITE_SECRET

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (s: string) => console.log(s)

/** Returns whether the condition held before the deadline. A timeout is a FAIL, not a crash. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) return false
    await sleep(10)
  }
  return true
}

const srv = await createHttpServer({ store: seedDemo(new LiveResourceStore()), announce: false })

async function write(value: string) {
  const raw = Buffer.from(
    JSON.stringify({
      patient: RAY,
      domain: 'weight_bearing',
      audience: 'user',
      value,
      authorId: 'okafor',
      authorLabel: 'Sarah Okafor, physio',
      priority: 0.9,
    }),
    'utf8',
  )
  const timestamp = new Date().toISOString()
  const res = await fetch(`${srv.baseUrl}/write`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unsay-timestamp': timestamp,
      'x-unsay-signature': signWriteBody(WRITE_SECRET, timestamp, raw),
    },
    body: raw,
  })
  if (!res.ok) throw new Error(`write rejected: HTTP ${res.status}`)
  return (await res.json()) as { version: number; versionHash: string }
}

log('unsay · probe · Last-Event-ID resumability\n')

const client = new Client({ name: 'unsay-resume-probe', version: '0.1.0' }, { capabilities: {} })
const updates: { uri: string; at: number }[] = []
client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
  updates.push({ uri: n.params.uri, at: Date.now() })
})

const token = mintToken({
  sub: 'alexa-host',
  scopes: ['care.read.user', 'care.read.assistant'],
  audience: srv.resourceUrl,
})

const checks: [string, boolean][] = []
const timing = { offlineWindowMs: -1, writeToReplayedAtClientMs: -1 }
let revisions: { live: number; missed: number } | null = null
let error: string | null = null

try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${srv.baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      reconnectionOptions: {
        initialReconnectionDelay: RECONNECT_DELAY_MS,
        maxReconnectionDelay: RECONNECT_DELAY_MS,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 6,
      },
    }),
  )

  if (!(await waitFor(() => srv.stats.sseOpens > 0, 5000))) {
    throw new Error('the client never opened a standalone SSE stream')
  }
  await sleep(100)
  await client.subscribeResource({ uri: WB })
  log(`  subscribed                  ${WB}`)

  // ── 1. a live revision, so the client holds an event id to resume from ─────
  // The standalone GET stream carries no priming event, so a client that has
  // received nothing has nothing to resume from. Revision A makes it resumable.
  const revA = await write('Partial weight-bearing, and use both crutches on the stairs.')
  checks.push(['revision A delivered on the live stream', await waitFor(() => updates.length >= 1, 5000)])
  log(`  revision A                  v${revA.version} · delivered live`)

  // ── 2. the network goes ────────────────────────────────────────────────────
  const resumesBefore = srv.stats.sseResumes
  srv.dropStreams()
  const droppedAt = Date.now()
  log('  SSE stream dropped          (as a proxy or a domestic wifi blip would)')

  // ── 3. the physio writes into the dark ─────────────────────────────────────
  const revB = await write('Full weight-bearing as tolerated.')
  const wroteAt = Date.now()
  revisions = { live: revA.version, missed: revB.version }
  checks.push([
    'revision B written while the stream was down',
    srv.stats.sseResumes === resumesBefore && updates.length === 1,
  ])
  log(`  revision B                  v${revB.version} · written with nothing listening`)

  // ── 4 & 5. the client comes back with Last-Event-ID ────────────────────────
  const resumed = await waitFor(() => srv.stats.sseResumes > resumesBefore, 10_000)
  checks.push(['client reconnected with Last-Event-ID', resumed && srv.stats.sseResumes === resumesBefore + 1])
  // Server-side timestamp of the resume request itself. Polling for it here would
  // read later than it happened and could make a genuine replay look like a live send.
  const resumedAt = srv.stats.lastResumeAt
  const replayed = await waitFor(() => updates.length >= 2, 10_000)
  const replayedAt = updates[1]?.at ?? 0

  checks.push(['missed notifications/resources/updated replayed', replayed && updates[1]?.uri === WB])
  checks.push(['replay arrived on the resumed stream, not the old one', replayed && replayedAt >= resumedAt])
  checks.push(['chain advanced by exactly two versions', revB.version === revA.version + 1])

  timing.offlineWindowMs = resumedAt - droppedAt
  timing.writeToReplayedAtClientMs = replayedAt - wroteAt
} catch (e) {
  error = e instanceof Error ? e.message : String(e)
  checks.push([`probe ran to completion (${error})`, false])
}

log('')
for (const [name, ok] of checks) log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)

const pass = checks.length > 0 && checks.every(([, ok]) => ok)
if (timing.offlineWindowMs >= 0) {
  log(`\n  offline window              ${timing.offlineWindowMs} ms`)
  log(`  write → replayed at client  ${timing.writeToReplayedAtClientMs} ms`)
}
log(`\n  VERDICT: ${pass ? 'PASS' : 'FAIL'}`)

mkdirSync('docs/proof', { recursive: true })
writeFileSync(
  'docs/proof/resume.json',
  JSON.stringify(
    {
      probe: 'last_event_id_resumability',
      ranAt: new Date().toISOString(),
      sdk: '@modelcontextprotocol/sdk@1.30.0',
      transport: 'StreamableHTTP',
      uri: WB,
      revisions,
      ...timing,
      sseOpens: srv.stats.sseOpens,
      sseResumes: srv.stats.sseResumes,
      storedEvents: srv.events.size,
      checks: Object.fromEntries(checks),
      error,
      verdict: pass ? 'PASS' : 'FAIL',
    },
    null,
    2,
  ) + '\n',
)
log('  receipt → docs/proof/resume.json')

await client.close().catch(() => {})
await srv.close()
process.exit(pass ? 0 : 1)
