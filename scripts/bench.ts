/**
 * bench — the one number the product lives or dies on.
 *
 * "Alexa retracts mid-sentence" is a LATENCY claim. If the correction arrives
 * after the sentence finishes, the product does not exist. So the headline metric
 * is not decoration — it is the thesis:
 *
 *   the clinician's signed write leaves → the subscribed client holds the new value
 *
 * measured end to end over Streamable HTTP against a mean spoken sentence, through
 * the same `createHttpServer()` that `npm start` runs: HMAC verification, the
 * store, the notification, and an authorized re-read are all inside the number.
 * An earlier version called `store.publish()` directly, which measured the
 * notification path but quietly left the clinician's half of the claim unmeasured.
 *
 * LESSONS R8: headline exactly ONE verifiable number with a runnable script.
 *
 * Run: npm run bench -- --n 200
 *      npm run bench -- --n 200 --url https://unsay-production.up.railway.app
 *
 * With --url, the same loop runs against a DEPLOYED server over the public
 * internet instead of a loopback one it starts itself. The token comes from the
 * landing page (a care.read.user token minted per request — all this URI needs),
 * so no server secret is required. Receipts go to docs/proof/bench.remote.* and
 * nothing else is rewritten: the README, DEMO.md and landing-page blocks stay
 * bound to the reproducible loopback run.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

import { DEV_WRITE_SECRET, createHttpServer, mintToken, signWriteBody } from '../src/http.ts'
import { LiveResourceStore, uriFor } from '../src/store.ts'
import { envelopeFromEnv } from '../src/envelope.ts'
import { RAY, seedDemo } from '../src/seed.ts'

const N = Number(process.argv[process.argv.indexOf('--n') + 1]) || 200
const REMOTE = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]!.replace(/\/+$/, '')
  : null
const WB = uriFor(RAY, 'weight_bearing', 'user')
const WRITE_SECRET = process.env.UNSAY_WRITE_SECRET ?? DEV_WRITE_SECRET

/**
 * A 12-word Alexa utterance at ~150 wpm ≈ 3.4 s of speech. This is the window a
 * correction must land inside to interrupt rather than follow. It is an
 * ASSUMPTION about speech rate, not a measurement of Alexa+ text-to-speech.
 */
const SPEECH_WINDOW_MS = 3400

/** A deployed server stands in for the local one: same routes, nothing to close. */
async function remoteServer(base: string) {
  const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as {
    resource: string
  }
  const landing = await (await fetch(`${base}/index.html`)).text()
  const tok = /href="echo\.html\?token=([^"&]+)"/.exec(landing)?.[1]
  if (!tok) throw new Error(`no demo token on ${base}/index.html — is the demo seed mounted?`)
  return {
    srv: {
      baseUrl: base,
      resourceUrl: meta.resource,
      atRest: `at-rest: as deployed (see ${base}/verify)`,
      close: async () => {},
    },
    token: decodeURIComponent(tok),
  }
}

const { srv, token } = REMOTE
  ? await remoteServer(REMOTE)
  : await (async () => {
      const envelope = await envelopeFromEnv()
      const srv = await createHttpServer({
        store: seedDemo(new LiveResourceStore({ envelope: envelope ?? undefined })),
        announce: false,
      })
      const token = mintToken({
        sub: 'bench',
        scopes: ['care.read.user', 'care.read.assistant'],
        audience: srv.resourceUrl,
        ttlSeconds: 3600,
      })
      return { srv, token }
    })()

const client = new Client({ name: 'unsay-bench', version: '0.1.0' }, { capabilities: {} })
let onNotify: (() => void) | null = null
client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => onNotify?.())
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${srv.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
)
await client.subscribeResource({ uri: WB })

const writeToNotify: number[] = []
const notifyToRead: number[] = []
const endToEnd: number[] = []
let subscribedEvery = true

for (let i = 0; i < N; i++) {
  const raw = Buffer.from(
    JSON.stringify({
      patient: RAY,
      domain: 'weight_bearing',
      audience: 'user',
      value: `Full weight-bearing as tolerated. (rev ${i + 1})`,
      authorId: 'okafor',
      authorLabel: 'Sarah Okafor, physio',
      priority: 0.9,
    }),
    'utf8',
  )
  const timestamp = new Date().toISOString()

  const t0 = performance.now()
  const got = new Promise<number>((res) => {
    onNotify = () => res(performance.now())
  })

  const res = await fetch(`${srv.baseUrl}/write`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unsay-timestamp': timestamp,
      'x-unsay-signature': signWriteBody(WRITE_SECRET, timestamp, raw),
    },
    body: raw,
  })
  if (!res.ok) throw new Error(`write rejected at rev ${i + 1}: HTTP ${res.status}`)
  // The server's own count of hosts holding a subscription to this URI. A run in
  // which nobody was listening would still produce timings, and they would mean
  // nothing — so the number is checked rather than assumed. A public deployment may
  // have other visitors subscribed too, so there it is "at least this client".
  const subs = ((await res.json()) as { subscribers: number }).subscribers
  if (REMOTE ? subs < 1 : subs !== 1) subscribedEvery = false

  const tN = await got
  await client.readResource({ uri: WB })
  const tR = performance.now()

  writeToNotify.push(tN - t0)
  notifyToRead.push(tR - tN)
  endToEnd.push(tR - t0)
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const row = (label: string, xs: number[]) =>
  `${label.padEnd(30)}${pct(xs, 50).toFixed(1).padStart(7)}ms${pct(xs, 95).toFixed(1).padStart(9)}ms${Math.max(...xs).toFixed(1).padStart(9)}ms`

const midSentence = endToEnd.filter((x) => x < SPEECH_WINDOW_MS).length

if (REMOTE) {
  const out = [
    `unsay bench · ${N} revisions · ${new Date().toISOString()}`,
    `transport: Streamable HTTP over the public internet → ${REMOTE}`,
    `client: this machine · sdk @modelcontextprotocol/sdk 1.30.0`,
    `path: POST /write (HMAC-SHA256 verified) → store → notification → authorized re-read`,
    srv.atRest,
    '',
    `${'segment'.padEnd(30)}${'p50'.padStart(9)}${'p95'.padStart(11)}${'max'.padStart(11)}`,
    row('signed write → notification', writeToNotify),
    row('notification → re-read', notifyToRead),
    '─'.repeat(61),
    row('END-TO-END (write → value)', endToEnd),
    '',
    `speech window: a 12-word utterance ≈ ${SPEECH_WINDOW_MS} ms (an assumed speech rate, not a`,
    `measurement of Alexa+ TTS)`,
    `retraction lands mid-sentence in ${midSentence}/${N} runs (${((midSentence / N) * 100).toFixed(0)}%)`,
    `a host was subscribed for every run: ${subscribedEvery ? 'yes' : 'NO — the timings mean nothing'}`,
    '',
    `NOTE: two real network hops are inside every figure — the clinician's write`,
    `travels client → server, and the notification and re-read travel server → client.`,
    `Both ends are the same machine here, so the round trip is paid twice; a clinician`,
    `and a host in different places each pay one leg. Not a measurement of Alexa+.`,
  ].join('\n')
  console.log(out)
  writeFileSync('docs/proof/bench.remote.txt', out + '\n')
  writeFileSync(
    'docs/proof/bench.remote.json',
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        n: N,
        transport: 'streamable-http-public-internet',
        url: REMOTE,
        speechWindowMs: SPEECH_WINDOW_MS,
        endToEnd: {
          p50: +pct(endToEnd, 50).toFixed(3),
          p95: +pct(endToEnd, 95).toFixed(3),
          max: +Math.max(...endToEnd).toFixed(3),
        },
        writeToNotification: { p50: +pct(writeToNotify, 50).toFixed(3), p95: +pct(writeToNotify, 95).toFixed(3) },
        midSentence: { count: midSentence, of: N },
        subscribedEveryRun: subscribedEvery,
      },
      null,
      2,
    ) + '\n',
  )
  console.log('\nreceipts → docs/proof/bench.remote.txt · docs/proof/bench.remote.json')
  await client.close()
  process.exit(midSentence === N && subscribedEvery ? 0 : 1)
}

const out = [
  `unsay bench · ${N} revisions · ${new Date().toISOString()}`,
  `transport: Streamable HTTP (loopback) · sdk @modelcontextprotocol/sdk 1.30.0`,
  `path: POST /write (HMAC-SHA256 verified) → store → notification → authorized re-read`,
  srv.atRest,
  '',
  `${'segment'.padEnd(30)}${'p50'.padStart(9)}${'p95'.padStart(11)}${'max'.padStart(11)}`,
  row('signed write → notification', writeToNotify),
  row('notification → re-read', notifyToRead),
  '─'.repeat(61),
  row('END-TO-END (write → value)', endToEnd),
  '',
  `speech window: a 12-word utterance ≈ ${SPEECH_WINDOW_MS} ms (an assumed speech rate, not a`,
  `measurement of Alexa+ TTS)`,
  `retraction lands mid-sentence in ${midSentence}/${N} runs (${((midSentence / N) * 100).toFixed(0)}%)`,
  `a host was subscribed for every run: ${subscribedEvery ? 'yes' : 'NO — the timings mean nothing'}`,
  '',
  `NOTE: loopback transport, and the change bus is in-process — the notifier in`,
  `packages/live-resources, not a queue and not a stream. The build plan's Week-1`,
  `gate was: if write → the client holds the new value exceeds 500 ms at p95, the`,
  `mid-sentence claim is false; move the change bus in-process. It is ${pct(endToEnd, 95).toFixed(1)} ms`,
  `here, so it moved, and no API Gateway, DynamoDB Stream or Lambda was ever built.`,
  `Nothing is deployed: no network hop between clinician and host is inside these`,
  `figures. Do not quote this number as the production figure.`,
].join('\n')

console.log(out)
writeFileSync('docs/proof/bench.txt', out + '\n')
writeFileSync(
  'docs/proof/bench.json',
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      n: N,
      transport: 'streamable-http-loopback',
      path: 'POST /write → notification → re-read',
      atRest: srv.atRest,
      speechWindowMs: SPEECH_WINDOW_MS,
      endToEnd: {
        p50: +pct(endToEnd, 50).toFixed(3),
        p95: +pct(endToEnd, 95).toFixed(3),
        max: +Math.max(...endToEnd).toFixed(3),
      },
      writeToNotification: { p50: +pct(writeToNotify, 50).toFixed(3), p95: +pct(writeToNotify, 95).toFixed(3) },
      midSentence: { count: midSentence, of: N },
      subscribedEveryRun: subscribedEvery,
    },
    null,
    2,
  ) + '\n',
)
/**
 * The two human-facing documents quote this table, and they used to transcribe it
 * by hand — so the block in README.md and DEMO.md matched neither docs/proof/bench.txt
 * nor any run that could be reproduced, while both documents asserted "that is the
 * committed run". Writing them from here closes it structurally: the same run
 * produces the receipt and the quote, and `test/docs.test.ts` fails if either is
 * edited afterwards.
 */
const docBlock = [
  `${'segment'.padEnd(30)}${'p50'.padStart(9)}${'p95'.padStart(11)}${'max'.padStart(11)}`,
  row('signed write → notification', writeToNotify),
  row('notification → re-read', notifyToRead),
  '─'.repeat(61),
  row('END-TO-END (write → value)', endToEnd),
  '',
  `retraction lands mid-sentence in ${midSentence}/${N} runs (${((midSentence / N) * 100).toFixed(0)}%)`,
  `a host was subscribed for every run: ${subscribedEvery ? 'yes' : 'NO — the timings mean nothing'}`,
].join('\n')

/** Replaces the fenced block between the two bench markers, and nothing else. */
function writeDocBlock(rel: string) {
  const file = new URL(`../${rel}`, import.meta.url)
  const body = readFileSync(file, 'utf8')
  const marked = body.replace(
    /(<!-- bench:begin[^>]*-->\n```\n)[\s\S]*?(\n```\n<!-- bench:end -->)/,
    (_m, head: string, tail: string) => `${head}${docBlock}${tail}`,
  )
  if (marked === body) {
    console.error(`bench: no bench:begin/bench:end block found in ${rel} — not updated`)
    return
  }
  writeFileSync(file, marked)
}
writeDocBlock('README.md')
writeDocBlock('DEMO.md')

/**
 * The landing page prints these figures, and `file://` cannot fetch a sibling file,
 * so they have to live in the page. Writing them here rather than by hand is what
 * makes that safe: the page cannot drift from the receipt because the same run
 * produces both. Rounding is always UP to one decimal, so a printed number can
 * never be faster than the measurement it came from.
 */
const up1 = (x: number) => Math.ceil(x * 10) / 10
const shown = {
  endToEnd: { p50: up1(pct(endToEnd, 50)), p95: up1(pct(endToEnd, 95)) },
  writeToNotification: { p50: up1(pct(writeToNotify, 50)) },
  n: N,
  midSentence,
}
const page = new URL('../web/index.html', import.meta.url)
const html = readFileSync(page, 'utf8')
  .replace(
    /(<script type="application\/json" id="bench"[^>]*>\n\s*)\{[^\n]*\}/,
    (_m, head: string) => `${head}${JSON.stringify(shown)}`,
  )
  .replace(/(<span data-bench="endToEnd\.p50">)[^<]*/, `$1${shown.endToEnd.p50.toFixed(1)}`)
  .replace(/(<span data-bench="endToEnd\.p95">)[^<]*/, `$1${shown.endToEnd.p95.toFixed(1)}`)
  .replace(/(<span data-bench="midSentence">)[^<]*/, `$1${shown.midSentence}`)
  .replace(/(<span data-bench="n">)[^<]*/, `$1${shown.n}`)
writeFileSync(page, html)

console.log(
  '\nreceipts → docs/proof/bench.txt · docs/proof/bench.json · web/index.html · README.md · DEMO.md',
)

await client.close()
await srv.close()
process.exit(midSentence === N && subscribedEvery ? 0 : 1)
