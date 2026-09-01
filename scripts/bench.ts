/**
 * bench — the one number the product lives or dies on.
 *
 * "Alexa retracts mid-sentence" is a LATENCY claim. If the correction arrives
 * after the sentence finishes, the product does not exist. So the headline metric
 * is not decoration — it is the thesis:
 *
 *   clinician write → the client holds the new value
 *
 * measured end to end over Streamable HTTP, against a mean spoken sentence.
 *
 * LESSONS R8: headline exactly ONE verifiable number with a runnable script.
 *
 * Run: npm run bench -- --n 200
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

import { buildServer } from '../src/server.ts'
import { LiveResourceStore, uriFor } from '../src/store.ts'
import { RAY, seed } from '../src/seed.ts'

const N = Number(process.argv[process.argv.indexOf('--n') + 1]) || 200
const PORT = 39_519
const WB = uriFor(RAY, 'weight_bearing', 'user')

/**
 * A 12-word Alexa utterance at ~150 wpm ≈ 3.4 s of speech. This is the window a
 * correction must land inside to interrupt rather than follow.
 */
const SPEECH_WINDOW_MS = 3400

const principal = () => ({ sub: 'bench', scopes: ['care.read.user', 'care.read.assistant'] })
const store = seed(new LiveResourceStore())
const { server } = buildServer({ store, principal })

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

const client = new Client({ name: 'unsay-bench', version: '0.1.0' }, { capabilities: {} })
let onNotify: (() => void) | null = null
client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => onNotify?.())
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))
await client.subscribeResource({ uri: WB })

const writeToNotify: number[] = []
const notifyToRead: number[] = []
const endToEnd: number[] = []

for (let i = 0; i < N; i++) {
  const t0 = performance.now()
  const got = new Promise<number>((res) => { onNotify = () => res(performance.now()) })

  store.publish({
    patient: RAY, domain: 'weight_bearing', audience: 'user',
    value: `Full weight-bearing as tolerated. (rev ${i + 1})`,
    authorId: 'okafor', authorLabel: 'Sarah Okafor, physio',
    writtenAt: new Date().toISOString(), priority: 0.9,
  })

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

const out = [
  `unsay bench · ${N} revisions · ${new Date().toISOString()}`,
  `transport: Streamable HTTP (loopback) · sdk @modelcontextprotocol/sdk 1.30.0`,
  '',
  `${'segment'.padEnd(30)}${'p50'.padStart(9)}${'p95'.padStart(11)}${'max'.padStart(11)}`,
  row('write → notification', writeToNotify),
  row('notification → re-read', notifyToRead),
  '─'.repeat(61),
  row('END-TO-END (write → value)', endToEnd),
  '',
  `speech window: a 12-word utterance ≈ ${SPEECH_WINDOW_MS} ms`,
  `retraction lands mid-sentence in ${midSentence}/${N} runs (${((midSentence / N) * 100).toFixed(0)}%)`,
  '',
  `NOTE: loopback transport. The deployed path adds API Gateway → DynamoDB Streams`,
  `→ Lambda; those segments are measured separately once deployed and this file is`,
  `regenerated. Do not quote this number as the production figure.`,
].join('\n')

console.log(out)
writeFileSync('docs/proof/bench.txt', out + '\n')
writeFileSync(
  'docs/proof/bench.json',
  JSON.stringify(
    {
      ranAt: new Date().toISOString(), n: N, transport: 'streamable-http-loopback',
      speechWindowMs: SPEECH_WINDOW_MS,
      endToEnd: { p50: +pct(endToEnd, 50).toFixed(3), p95: +pct(endToEnd, 95).toFixed(3), max: +Math.max(...endToEnd).toFixed(3) },
      writeToNotification: { p50: +pct(writeToNotify, 50).toFixed(3), p95: +pct(writeToNotify, 95).toFixed(3) },
      midSentence: { count: midSentence, of: N },
    },
    null, 2,
  ) + '\n',
)
console.log('\nreceipts → docs/proof/bench.txt · docs/proof/bench.json')

await client.close()
await server.close()
http.close()
process.exit(midSentence === N ? 0 : 1)
