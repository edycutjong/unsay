/**
 * End-to-end: the demo, executed as code, over Streamable HTTP.
 *
 * This is the judged path. It runs the exact sequence the video shows, against a
 * real MCP client on the real transport, and writes a receipt to
 * docs/proof/live_run.jsonl.
 *
 * LESSONS R10: ship the real artifact and replay the INPUTS, never a placeholder
 * output. LESSONS R5: the receipt goes on disk on day two, not week six.
 *
 * Run: npm run e2e
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

import { buildServer } from '../src/server.ts'
import { LiveResourceStore, uriFor } from '../src/store.ts'
import { DEMO_NOW, RAY, STAGED_REVISION, seed } from '../src/seed.ts'

const PORT = 39_518
const WB = uriFor(RAY, 'weight_bearing', 'user')
const RISK = uriFor(RAY, 'risk', 'assistant')
const SPEECH_WINDOW_MS = 3400

// The host holds BOTH scopes — it is the model-reasoning principal.
const principal = () => ({ sub: 'alexa-host', scopes: ['care.read.user', 'care.read.assistant'] })

const store = seed(new LiveResourceStore())
const { server } = buildServer({ store, principal, now: () => DEMO_NOW })

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
await server.connect(transport)

const http = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    let parsed: unknown
    if (raw.length) { try { parsed = JSON.parse(raw.toString('utf8')) } catch { /* GET */ } }
    transport.handleRequest(req, res, parsed)
  })
})
await new Promise<void>((r) => http.listen(PORT, r))

const client = new Client({ name: 'unsay-e2e', version: '0.1.0' }, { capabilities: {} })
let notifiedAt = 0
let resolveNotified: () => void
const notified = new Promise<void>((r) => { resolveNotified = r })
client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
  notifiedAt = performance.now()
  resolveNotified()
})
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))

const frames: Record<string, unknown>[] = []
const rec = (event: string, data: Record<string, unknown>) => {
  const f = { t: new Date().toISOString(), event, ...data }
  frames.push(f)
  return f
}

const say = (s: string) => console.log(s)
say('unsay · end-to-end · the demo as code\n')

// 1 — capability negotiation
const caps = client.getServerCapabilities()
rec('initialize', { capabilities: caps })
say(`  capabilities.resources    ${JSON.stringify(caps?.resources)}`)
say(`  completions               ${caps?.completions ? 'declared' : 'absent'}`)
say(`  instructions              ${client.getInstructions() ? 'present' : 'absent'}`)

// 2 — templates
const tpl = await client.listResourceTemplates()
rec('templates/list', { count: tpl.resourceTemplates.length })
say(`\n  templates                 ${tpl.resourceTemplates.map((t) => t.uriTemplate).join(', ')}`)

// 3 — completion using context.arguments (the near-unused surface)
const comp = await client.complete({
  ref: { type: 'ref/resource', uri: 'care://{patient}/{domain}/{version}' },
  argument: { name: 'version', value: '' },
  context: { arguments: { patient: RAY, domain: 'weight_bearing' } },
})
rec('completion/complete', { arg: 'version', context: { domain: 'weight_bearing' }, values: comp.completion.values })
say(`  completion {version}      ${JSON.stringify(comp.completion.values)}  ← resolved via context.arguments`)

// 4 — Ray asks. The assistant reads the speakable fact…
const before = await client.readResource({ uri: WB })
const beforeText = (before.contents[0] as { text: string }).text
rec('resources/read', { uri: WB, audience: 'user' })
say(`\n  RAY   "Can I put weight on it yet?"`)
say(`  read  ${WB}`)
say(`        ${beforeText.split('\n')[1]}`)

// …and the reasoning-only fact, which shapes the answer and is never spoken.
const risk = await client.readResource({ uri: RISK })
rec('resources/read', { uri: RISK, audience: 'assistant', spoken: false })
say(`  read  ${RISK}   ← audience:assistant · NOT SPOKEN`)

// 5 — subscribe, then the physio writes mid-answer
await client.subscribeResource({ uri: WB })
rec('resources/subscribe', { uri: WB })
say(`\n  subscribed to ${WB}`)

const t0 = performance.now()
store.publish({ ...STAGED_REVISION, writtenAt: DEMO_NOW.toISOString() })
await Promise.race([
  notified,
  new Promise((_, rej) => setTimeout(() => rej(new Error('no notification in 5s')), 5000)),
])
const latencyMs = notifiedAt - t0
rec('notifications/resources/updated', { uri: WB, latencyMs: Number(latencyMs.toFixed(3)) })

// 6 — the assistant re-reads and retracts
const after = await client.readResource({ uri: WB })
const afterText = (after.contents[0] as { text: string }).text
const corrected = afterText.includes(STAGED_REVISION.value)
rec('resources/read', { uri: WB, afterCorrection: true, value: STAGED_REVISION.value })

say(`\n  notifications/resources/updated  ${latencyMs.toFixed(2)} ms`)
say(`  ALEXA "You can put about half your weight on it—"`)
say(`        "—actually, stop. That changed just now."`)
say(`        "${STAGED_REVISION.authorLabel} has moved you to full weight-bearing as tolerated."`)
say(`        "Take it slowly the first time, and have someone nearby."   ← from ${RISK}, reason never spoken`)

// 7 — the stale fact announces its own age
const anti = await client.readResource({ uri: uriFor(RAY, 'anticoagulant', 'user') })
const antiText = (anti.contents[0] as { text: string }).text
const announcesAge = antiText.startsWith('[STALE')
rec('resources/read', { uri: uriFor(RAY, 'anticoagulant', 'user'), stale: announcesAge })
say(`\n  stale fact                ${announcesAge ? 'announces its own age' : 'DID NOT announce age'}`)
say(`        ${antiText.split('\n')[0]}`)

// 8 — the fallback path, exercised (R10: an unexercised seam is a missing feature)
const tool = await client.callTool({ name: 'whats_changed', arguments: { since: new Date(DEMO_NOW.getTime() - 3600_000).toISOString() } })
const changed = (tool.structuredContent as { changed: unknown[] }).changed
rec('tools/call', { tool: 'whats_changed', changedCount: changed.length })
say(`  fallback whats_changed    ${changed.length} revision(s) — exercised, not just built`)

// 9 — receipt
const midSentence = latencyMs < SPEECH_WINDOW_MS
const ok = corrected && announcesAge && midSentence && changed.length === 1

writeFileSync('docs/proof/live_run.jsonl', frames.map((f) => JSON.stringify(f)).join('\n') + '\n')
appendFileSync(
  'docs/proof/live_run.jsonl',
  JSON.stringify({
    t: new Date().toISOString(),
    event: 'summary',
    writeToNotificationMs: Number(latencyMs.toFixed(3)),
    speechWindowMs: SPEECH_WINDOW_MS,
    landsMidSentence: midSentence,
    correctionApplied: corrected,
    staleFactAnnouncedAge: announcesAge,
    fallbackExercised: changed.length === 1,
    verdict: ok ? 'PASS' : 'FAIL',
  }) + '\n',
)

say(`\n  ${ok ? 'PASS' : 'FAIL'} — receipt → docs/proof/live_run.jsonl (${frames.length + 1} frames)`)

await client.close()
await server.close()
http.close()
process.exit(ok ? 0 : 1)
