/**
 * End-to-end: the demo, executed as code, over the real HTTP server.
 *
 * This is the judged path. It runs the exact sequence the video shows against
 * `createHttpServer()` — the same process `npm start` runs — with a spec-compliant
 * MCP client, a real Bearer token, and the physio's correction arriving through
 * the SIGNED clinician write path rather than a direct call into the store. It
 * writes a receipt to docs/proof/live_run.jsonl.
 *
 * LESSONS R10: ship the real artifact and replay the INPUTS, never a placeholder
 * output. LESSONS R5: the receipt goes on disk on day two, not week six.
 * LESSONS R11: a step that cannot fail proves nothing — so the unauthorized read
 * and the unauthenticated request are asserted here too, not just in the tests.
 *
 * Run: npm run e2e
 * Encrypted at rest: UNSAY_KEY_PROVIDER=local UNSAY_MASTER_KEY=$(npm run -s keygen) npm run e2e
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { DEV_WRITE_SECRET, createHttpServer, mintToken, signWriteBody } from '../src/http.ts'
import { LiveResourceStore, uriFor } from '../src/store.ts'
import { envelopeFromEnv } from '../src/envelope.ts'
import { DEMO_NOW, RAY, STAGED_REVISION, seedDemo } from '../src/seed.ts'
import { UI_ECHO_URI, UI_MIME_TYPE } from '../src/ui_resource.ts'

/**
 * The Alexa+ track's one hard eligibility requirement, asserted rather than
 * inferred from a caret range in package.json: "a self-hosted MCP server,
 * implementing MCP spec version 2025-11-25 (minimum) over Streamable HTTP".
 */
const REQUIRED_PROTOCOL = '2025-11-25'

const WB = uriFor(RAY, 'weight_bearing', 'user')
const RISK = uriFor(RAY, 'risk', 'assistant')
const CLIP = uriFor(RAY, 'exercise_clip', 'user')
const SPEECH_WINDOW_MS = 3400
const WRITE_SECRET = process.env.UNSAY_WRITE_SECRET ?? DEV_WRITE_SECRET

// The clock is pinned so the staleness claim and the version hashes are the same
// on a judge's machine as on ours. The server, the token and the signed write all
// read from it, which is also why a token minted at wall-clock time would be
// expired the moment the server looked at it.
const now = () => DEMO_NOW

const envelope = await envelopeFromEnv()
const srv = await createHttpServer({
  store: seedDemo(new LiveResourceStore({ envelope: envelope ?? undefined })),
  now,
  announce: false,
})

const frames: Record<string, unknown>[] = []
const rec = (event: string, data: Record<string, unknown>) => {
  frames.push({ t: new Date().toISOString(), event, ...data })
}

/** The Agent Skill shipped alongside the server — the other Alexa+ deliverable. */
const skillBytes = readFileSync(new URL('../skill/SKILL.md', import.meta.url)).length

/**
 * Every line printed, kept so the run can write its own quote into the documents.
 *
 * README.md and DEMO.md both said `read ui://unsay/echo ← text/html+skybridge ·
 * 33625 bytes` under a sentence promising the block was verbatim apart from one
 * latency figure. The script prints 34404 and docs/proof/live_run.jsonl, written by
 * this same script, already said 34404 — one hand-typed number in the flagship
 * block, on the line that exists only because the track is Alexa+ (LESSONS R6,
 * eight prior losses). `scripts/bench.ts` has written its table into both documents
 * since day 6; the block a judge reads first was still transcribed.
 */
const lines: string[] = []
/** The shorter selection of the same lines that README.md quotes. */
const excerpt: string[] = []

const say = (s: string) => {
  lines.push(s)
  console.log(s)
}

/** …and README.md quotes this line too. */
const sayq = (s: string) => {
  say(s)
  excerpt.push(s.replace(/^\n+/, ''))
}

/** A blank line between two groups of the excerpt, never a leading one. */
const gap = () => {
  if (excerpt.length) excerpt.push('')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls a predicate to a deadline. A timeout returns false; it never throws. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) return false
    await sleep(10)
  }
  return true
}

/** A correctly signed POST /write for the weight-bearing chain. */
function signedRevision(value: string): RequestInit {
  const raw = Buffer.from(
    JSON.stringify({
      patient: RAY,
      domain: STAGED_REVISION.topic,
      audience: STAGED_REVISION.audience,
      value,
      authorId: STAGED_REVISION.authorId,
      authorLabel: STAGED_REVISION.authorLabel,
      priority: STAGED_REVISION.priority,
    }),
    'utf8',
  )
  const ts = now().toISOString()
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unsay-timestamp': ts,
      'x-unsay-signature': signWriteBody(WRITE_SECRET, ts, raw),
    },
    body: raw,
  }
}

/** Soft-wrap a spoken sentence so the transcript stays readable in a terminal. */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}
say('unsay · end-to-end · the demo as code\n')
say(`  ${srv.atRest}`)

// ── 0 — the door is actually locked ────────────────────────────────────────
// Asserted first, because every step after it is worthless if /mcp is open.
const anon = await fetch(`${srv.baseUrl}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
})
const challenge = anon.headers.get('www-authenticate') ?? ''
const doorLocked = anon.status === 401 && challenge.includes('resource_metadata=')
rec('unauthenticated', { status: anon.status, wwwAuthenticate: challenge })
say(`  no token                  HTTP ${anon.status} · ${challenge.split(',')[0]}`)

const token = (sub: string, scopes: string[]) =>
  mintToken({ sub, scopes, audience: srv.resourceUrl, now: DEMO_NOW })

// The host holds BOTH scopes — it is the model-reasoning principal.
const hostToken = token('alexa-host', ['care.read.user', 'care.read.assistant'])

const client = new Client({ name: 'unsay-e2e', version: '0.1.0' }, { capabilities: {} })
let notifiedAt = 0
let resolveNotified: () => void
const notified = new Promise<void>((r) => {
  resolveNotified = r
})
let updates = 0
client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
  updates++
  notifiedAt = performance.now()
  resolveNotified()
})
let logMessages = 0
client.setNotificationHandler(LoggingMessageNotificationSchema, () => {
  logMessages++
})
const transport = new StreamableHTTPClientTransport(new URL(`${srv.baseUrl}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${hostToken}` } },
})
await client.connect(transport)

// 1 — capability negotiation, and the eligibility requirement
const caps = client.getServerCapabilities()
const negotiated = transport.protocolVersion ?? ''
const specOk = negotiated >= REQUIRED_PROTOCOL
rec('initialize', { capabilities: caps, protocolVersion: negotiated })
sayq(`\n  protocolVersion           ${negotiated}${specOk ? ` ≥ ${REQUIRED_PROTOCOL} — Alexa+ track minimum` : ` — BELOW the ${REQUIRED_PROTOCOL} minimum`}`)
say(`  capabilities.resources    ${JSON.stringify(caps?.resources)}`)
say(`  completions · prompts     ${caps?.completions ? 'declared' : 'absent'} · ${caps?.prompts ? 'declared' : 'absent'}`)
say(`  logging                   ${caps?.logging ? 'declared' : 'absent'}`)
say(`  instructions              ${client.getInstructions() ? 'present' : 'absent'}`)

// 2 — templates, and the paginated list
const tpl = await client.listResourceTemplates()
rec('templates/list', { count: tpl.resourceTemplates.length })
say(`\n  templates                 ${tpl.resourceTemplates.map((t) => t.uriTemplate).join(', ')}`)

let cursor: string | undefined
let pages = 0
const listed: string[] = []
do {
  const page = await client.listResources(cursor ? { cursor } : {})
  listed.push(...page.resources.map((r) => r.uri))
  cursor = page.nextCursor
  pages++
} while (cursor)
rec('resources/list', { pages, uris: listed })
sayq(`  resources/list            ${listed.length} resources over ${pages} cursor page(s)`)

// 2b — the Alexa+ card, delivered THROUGH MCP rather than by a static HTTP route
const card = await client.readResource({ uri: UI_ECHO_URI })
const cardPart = card.contents[0] as { mimeType?: string; text?: string }
const uiOk = cardPart?.mimeType === UI_MIME_TYPE && (cardPart.text ?? '').includes('<!doctype html>')
rec('resources/read', { uri: UI_ECHO_URI, mimeType: cardPart?.mimeType, bytes: (cardPart.text ?? '').length })
sayq(`  read  ${UI_ECHO_URI}   ← ${cardPart?.mimeType} · ${(cardPart.text ?? '').length} bytes · MCP Apps card`)
say(`  agent skill               skill/SKILL.md — ${skillBytes} bytes, the same two rules as instructions`)

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
const beforeMeta = (before.contents[0] as { _meta: Record<string, unknown> })._meta
rec('resources/read', { uri: WB, audience: 'user', meta: beforeMeta })
say(`\n  RAY   "Can I put weight on it yet?"`)
say(`  read  ${WB}`)
say(`        ${beforeText.split('\n')[1]}`)
say(`        _meta v${beforeMeta['unsay/version']} · prevHash ${String(beforeMeta['unsay/prevHash']).slice(0, 12)}…`)

// …and the reasoning-only fact, which shapes the answer and is never spoken.
const risk = await client.readResource({ uri: RISK })
rec('resources/read', { uri: RISK, audience: 'assistant', spoken: false })
say(`  read  ${RISK}   ← audience:assistant · NOT SPOKEN`)

// …and the clip, which is a real blob on the same URI and the same authorization.
const clip = await client.readResource({ uri: CLIP })
const blob = clip.contents.find((c) => 'blob' in c) as { blob: string; mimeType: string } | undefined
const blobBytes = blob ? Buffer.from(blob.blob, 'base64').length : 0
rec('resources/read', { uri: CLIP, blob: blob?.mimeType ?? null, bytes: blobBytes })
say(`  read  ${CLIP}   ← ${blob?.mimeType} · ${blobBytes} bytes`)

// 5 — the partition, asserted rather than described
const rayToken = token('echo-show', ['care.read.user'])
const ray = new Client({ name: 'unsay-e2e-ray', version: '0.1.0' }, { capabilities: {} })
await ray.connect(
  new StreamableHTTPClientTransport(new URL(`${srv.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${rayToken}` } },
  }),
)
let partitionHeld = false
try {
  await ray.readResource({ uri: RISK })
} catch (e) {
  partitionHeld = /-32002|not found/i.test(String(e))
}
const rayList = await ray.listResources({})
const rayLeak = rayList.resources.filter((r) => r.uri.startsWith('care-internal://'))
rec('audience partition', { uri: RISK, refusedForUserScope: partitionHeld, leakedUris: rayLeak.length })
gap()
sayq(`\n  Ray's own host reads ${RISK}`)
sayq(`        ${partitionHeld ? '-32002 Resource not found — same answer as for a URI that does not exist' : 'LEAKED'}`)
await ray.close()

// 6 — subscribe, then the physio writes mid-answer through the SIGNED path
await client.subscribeResource({ uri: WB })
rec('resources/subscribe', { uri: WB })
say(`\n  subscribed to ${WB}`)

const body = Buffer.from(
  JSON.stringify({
    patient: RAY,
    domain: STAGED_REVISION.topic,
    audience: STAGED_REVISION.audience,
    value: STAGED_REVISION.value,
    authorId: STAGED_REVISION.authorId,
    authorLabel: STAGED_REVISION.authorLabel,
    priority: STAGED_REVISION.priority,
  }),
  'utf8',
)
const timestamp = now().toISOString()

// A tampered body first: one byte changed after signing must be refused, and the
// refusal must say nothing about which check failed.
const tamperedRes = await fetch(`${srv.baseUrl}/write`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-unsay-timestamp': timestamp,
    'x-unsay-signature': signWriteBody(WRITE_SECRET, timestamp, body),
  },
  body: Buffer.from(body.toString('utf8').replace('Full weight-bearing', 'Non-weight-bearing')),
})
const tamperRefused = tamperedRes.status === 401
rec('write rejected', { status: tamperedRes.status, reason: 'one byte changed after signing' })
gap()
sayq(`  tampered write            HTTP ${tamperedRes.status} ${tamperRefused ? '· refused, and says nothing about why' : '· ACCEPTED — the signature is not load-bearing'}`)

const t0 = performance.now()
const writeRes = await fetch(`${srv.baseUrl}/write`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-unsay-timestamp': timestamp,
    'x-unsay-signature': signWriteBody(WRITE_SECRET, timestamp, body),
  },
  body,
})
const written = (await writeRes.json()) as {
  version: number
  versionHash: string
  subscribers: number
}
await Promise.race([
  notified,
  new Promise((_, rej) => setTimeout(() => rej(new Error('no notification in 5s')), 5000)),
])
const latencyMs = notifiedAt - t0
rec('notifications/resources/updated', {
  uri: WB,
  latencyMs: Number(latencyMs.toFixed(3)),
  version: written.version,
  subscribers: written.subscribers,
})

// 7 — the assistant re-reads and retracts
const after = await client.readResource({ uri: WB })
const afterText = (after.contents[0] as { text: string }).text
const afterMeta = (after.contents[0] as { _meta: Record<string, unknown> })._meta
const corrected = afterText.includes(STAGED_REVISION.value)
const chained = afterMeta['unsay/prevHash'] === beforeMeta['unsay/versionHash']
rec('resources/read', { uri: WB, afterCorrection: true, value: STAGED_REVISION.value, chained })

/**
 * The retraction is READ OFF THE SERVER, not typed into this script. It used to be
 * a string literal here, a different literal in DEMO.md and a third in
 * web/index.html — three wordings of the one artifact the product is named for,
 * generated by nothing. src/retraction.ts owns it now and this line prints it.
 */
const spoken = String(afterMeta['unsay/retraction'] ?? '')
const withdrawn = beforeText.split('\n')[1]!.replace(/\.$/, '')
const retractionOk =
  // withdraws before it explains, names the sentence being dropped, names the one
  // that replaced it, and names who changed it — the four things a retraction is
  spoken.startsWith('Wait') &&
  spoken.includes(withdrawn) &&
  spoken.includes(STAGED_REVISION.value.replace(/\.$/, '')) &&
  spoken.includes(STAGED_REVISION.authorLabel)
rec('unsay/retraction', { uri: WB, rendered: spoken, from: 'src/retraction.ts' })

sayq(`\n  POST /write               HTTP ${writeRes.status} · v${written.version} · ${written.subscribers} subscribed host(s)`)
sayq(`  notifications/resources/updated  ${latencyMs.toFixed(2)} ms`)
sayq(`  ALEXA "You can put about half your weight on it—"`)
for (const line of wrap(spoken, 66)) sayq(`        ${line}`)
say(`        "Take it slowly the first time, and have someone nearby."   ← from ${RISK}, reason never spoken`)
sayq(`  _meta unsay/retraction    rendered by src/retraction.ts, not typed into this script`)
sayq(`  v${afterMeta['unsay/version']}.prevHash === v${beforeMeta['unsay/version']}.versionHash  ${chained ? 'YES — the retraction is auditable' : 'NO'}`)

// 8 — the stale fact announces its own age
const anti = await client.readResource({ uri: uriFor(RAY, 'anticoagulant', 'user') })
const antiText = (anti.contents[0] as { text: string }).text
const announcesAge = antiText.startsWith('[STALE')
rec('resources/read', { uri: uriFor(RAY, 'anticoagulant', 'user'), stale: announcesAge })
say(`\n  stale fact                ${announcesAge ? 'announces its own age' : 'DID NOT announce age'}`)
say(`        ${antiText.split('\n')[0]}`)

// 9 — the briefing prompt, which structurally cannot speak the internal record
const brief = await client.getPrompt({ name: 'brief_carer', arguments: {} })
const briefText = (brief.messages[0]!.content as { text: string }).text
const briefClean = !/Fall risk|disputes the discharge plan|care-internal:/.test(briefText)
rec('prompts/get', { name: 'brief_carer', speakableOnly: briefClean, chars: briefText.length })
say(`  prompts/get brief_carer   ${briefClean ? 'speakable only' : 'LEAKED reasoning-only content'} · ${briefText.length} chars`)

// 10 — the fallback path, exercised (R10: an unexercised seam is a missing feature)
const tool = await client.callTool({
  name: 'whats_changed',
  arguments: { since: new Date(DEMO_NOW.getTime() - 3600_000).toISOString() },
})
const changed = (tool.structuredContent as {
  changed: { uri: string; value: string; previousValue?: string; retraction?: string }[]
}).changed
// A host on this path never read v1. Without `previousValue` it can state the new
// fact and cannot RETRACT the old one — which is the whole product. Asserted here
// because e2e is the only place the fallback runs against a real revision.
const fallbackRetracts = changed.every((c) => typeof c.previousValue === 'string' && !!c.retraction)
rec('tools/call', { tool: 'whats_changed', changedCount: changed.length, carriesPreviousValue: fallbackRetracts })
gap()
sayq(`  fallback whats_changed    ${changed.length} revision(s) — exercised, not just built`)
say(`        previousValue       ${fallbackRetracts ? `"${changed[0]!.previousValue}"  ← the fallback can retract, not only restate` : 'MISSING — this path can only restate'}`)

// 10b — logging/setLevel, honoured rather than merely served
// The `logging` capability makes the SDK answer logging/setLevel with `{}`. That
// result is a success even when nothing filters, which is exactly how this server
// used to behave: sendLoggingMessage() was called with no session id, the SDK's
// per-session level filter looked up `undefined`, missed, and delivered every
// notice at every level. R10 — a seam nothing exercises is a seam that is not there.
// The channel has to be ALIVE before suppressing it proves anything: a check that
// counts zero before and zero after passes on a log channel that never worked.
const loggingDelivered = await waitFor(() => logMessages > 0, 5000)
const logsAfterFirstWrite = logMessages
await client.setLoggingLevel('emergency')
const quietBody = signedRevision('Full weight-bearing as tolerated, reviewed at the door.')
const quietRes = await fetch(`${srv.baseUrl}/write`, quietBody)
const updatesBeforeQuiet = updates
await waitFor(() => updates > updatesBeforeQuiet, 5000)
const loggingHonoured = quietRes.status === 200 && logMessages === logsAfterFirstWrite
const stillNotified = updates > updatesBeforeQuiet
rec('logging/setLevel', {
  level: 'emergency',
  logsBefore: logsAfterFirstWrite,
  logsAfter: logMessages,
  resourceUpdatedStillDelivered: stillNotified,
})
say(`\n  notifications/message     ${logsAfterFirstWrite} revision notice(s) delivered on the log channel`)
sayq(`  logging/setLevel          notice suppressed at level emergency — ${logMessages - logsAfterFirstWrite} log message(s) after the write`)
say(`                            notifications/resources/updated still delivered: ${stillNotified ? 'YES' : 'NO'}`)

// 11 — the public verification route a judge can click
const verifyRes = await fetch(`${srv.baseUrl}/verify`, { headers: { accept: 'application/json' } })
const verdict = (await verifyRes.json()) as {
  intact: boolean
  versions: number
  chains: unknown[]
  receipts: { encrypted: boolean }[]
}
const sealed = verdict.receipts.filter((r) => r.encrypted).length
rec('GET /verify', { intact: verdict.intact, versions: verdict.versions, sealed })
say(`\n  GET /verify (no token)    ${verdict.chains.length} chains · ${verdict.versions} versions · intact ${verdict.intact} · ${sealed}/${verdict.receipts.length} sealed at rest`)

// 12 — receipt
const midSentence = latencyMs < SPEECH_WINDOW_MS
const ok =
  doorLocked &&
  specOk &&
  uiOk &&
  retractionOk &&
  loggingDelivered &&
  loggingHonoured &&
  stillNotified &&
  fallbackRetracts &&
  partitionHeld &&
  rayLeak.length === 0 &&
  blobBytes > 0 &&
  tamperRefused &&
  written.subscribers === 1 &&
  corrected &&
  chained &&
  announcesAge &&
  briefClean &&
  midSentence &&
  changed.length === 1 &&
  verdict.intact

writeFileSync('docs/proof/live_run.jsonl', frames.map((f) => JSON.stringify(f)).join('\n') + '\n')
appendFileSync(
  'docs/proof/live_run.jsonl',
  JSON.stringify({
    t: new Date().toISOString(),
    event: 'summary',
    atRest: srv.atRest,
    protocolVersion: negotiated,
    protocolVersionMeetsTrackMinimum: specOk,
    unauthenticatedRefused: doorLocked,
    mcpAppsCardServed: uiOk,
    retractionRenderedServerSide: retractionOk,
    loggingChannelDelivered: loggingDelivered,
    loggingSetLevelHonoured: loggingHonoured,
    fallbackCarriesPreviousValue: fallbackRetracts,
    audiencePartitionHeld: partitionHeld && rayLeak.length === 0,
    blobBytes,
    tamperedWriteRefused: tamperRefused,
    subscribersNotified: written.subscribers,
    writeToNotificationMs: Number(latencyMs.toFixed(3)),
    speechWindowMs: SPEECH_WINDOW_MS,
    landsMidSentence: midSentence,
    correctionApplied: corrected,
    retractionChainsToPreviousVersion: chained,
    staleFactAnnouncedAge: announcesAge,
    briefingSpeakableOnly: briefClean,
    fallbackExercised: changed.length === 1,
    chainIntact: verdict.intact,
    verdict: ok ? 'PASS' : 'FAIL',
  }) + '\n',
)

gap()
sayq(`\n  ${ok ? 'PASS' : 'FAIL'} — receipt → docs/proof/live_run.jsonl (${frames.length} frames + summary)`)

/**
 * The documents quote this run, written from it rather than typed after it.
 *
 * `scripts/bench.ts` has written its table into README.md and DEMO.md since day 6,
 * for exactly this reason. The e2e block was not covered by it and drifted: both
 * files said `33625 bytes` for the MCP Apps card while this script and
 * docs/proof/live_run.jsonl both said 34404, under a sentence promising every
 * figure came out of the command above it. DEMO.md gets the whole capture,
 * README.md the shorter selection `sayq()` marks; `test/docs.test.ts` fails if
 * either is edited afterwards, or if the two disagree.
 *
 * Only the plaintext PASS writes. A failing run must not leave a green block
 * behind, and the encrypted run differs on three lines DEMO.md quotes separately.
 */
const CAVEAT = (tail: string) =>
  `The \`${latencyMs.toFixed(2)} ms\` will differ on your machine and between two runs on this one;\n` +
  `it is the only figure in this block that moves, ${tail}`

/** Replaces the fenced block and its caveat between the two e2e markers, and nothing else. */
function writeDocBlock(rel: string, block: string, caveat: string) {
  const file = new URL(`../${rel}`, import.meta.url)
  const body = readFileSync(file, 'utf8')
  const marked = body.replace(
    /(<!-- e2e:begin[^\n]*-->\n```\n)[\s\S]*?(\n```\n\n)[\s\S]*?(\n<!-- e2e:end -->)/,
    (_m, head: string, mid: string, tail: string) => `${head}${block}${mid}${caveat}${tail}`,
  )
  if (marked === body) {
    console.error(`e2e: no e2e:begin/e2e:end block found in ${rel} — not updated`)
    return
  }
  writeFileSync(file, marked)
}

if (ok && envelope === null) {
  writeDocBlock('DEMO.md', lines.join('\n'),
    CAVEAT('and `npm run e2e` rewrites this block and the receipt from the same run.'))
  writeDocBlock('README.md', excerpt.join('\n'),
    CAVEAT('and it is not the headline number — [the bench](#the-number) is.'))
  console.log('\n  quoted in                 README.md · DEMO.md — written by this run')
}

await client.close()
await srv.close()
process.exit(ok ? 0 : 1)
