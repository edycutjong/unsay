/**
 * verify — asserts the SAFETY PROPERTY, not the happy path.
 *
 * LESSONS R11: "A function that returns {success: true} proves the function
 * returned; it does not prove a transaction landed." BagOS shipped 337 tests at
 * 100% coverage over two write tools that "built transactions, discarded them,
 * and reported success". Every gate went green on an inert build.
 *
 * So this script does not check that reads work. It checks that the reads which
 * MUST fail, fail — and it exits non-zero if any of them succeed.
 *
 * Sections 1-5 and 7 assert guarantees that hold inside one process: the audience
 * partition, the hash chain, staleness, and the AAD binding that survives an
 * attacker with write access to storage. Sections 6, 8 and 9 assert the ones that
 * only exist once the code is behind a socket: the OAuth scope boundary over real
 * HTTP, the signed clinician write path, and the clock the entrypoint itself runs
 * on with no injected store and no injected `now`.
 *
 * Run: npm run verify
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { Envelope, LocalKeyProvider, recordAad } from '../src/envelope.ts'
import {
  DEV_WRITE_SECRET,
  createHttpServer,
  mintToken,
  signWriteBody,
  WRITE_SKEW_MS,
} from '../src/http.ts'
import { LiveResourceStore, NotFoundError, uriFor } from '../src/store.ts'
import { seed, seedDemo, RAY, DEMO_NOW } from '../src/seed.ts'

let failures = 0
/**
 * Every assertion is recorded as well as printed. The landing page quotes the
 * COUNT, and a count typed into a page beside a script that produces it is a count
 * that goes stale — this one drifted from eleven to twenty-nine unnoticed. The
 * receipt is what web/web.test.ts compares the page against, the same way it
 * compares the latency figures against docs/proof/bench.json.
 */
const asserted: { section: number; name: string; ok: boolean; detail: string }[] = []

/** Sections that only exist once the code is behind a socket. See the file header. */
const OVER_HTTP = new Set([6, 8, 9])
let section = 0
const heading = (n: number, title: string) => {
  section = n
  console.log(`${n === 1 ? '' : '\n'}${n}. ${title}`)
}

const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  asserted.push({ section, name, ok, detail })
  if (!ok) failures++
}

console.log('unsay · verify · safety properties\n')

const store = new LiveResourceStore()
seed(store)

// A patient-facing principal. Holds the user scope ONLY.
const userOnly = { sub: 'alexa-host', scopes: ['care.read.user'] }
// A principal holding both — the model-reasoning path.
const both = { sub: 'reasoner', scopes: ['care.read.user', 'care.read.assistant'] }

// ── 1. every assistant-only URI must be unreachable with a user-scoped token ──
heading(1, 'audience partition')
const internalDomains = ['risk', 'adherence']
for (const domain of internalDomains) {
  const uri = uriFor(RAY, domain, 'assistant')
  let leaked = false
  let sawNotFound = false
  try {
    const r = store.read(uri, userOnly)
    leaked = true
    console.log(`      LEAKED: ${uri} → "${r.value.slice(0, 60)}"`)
  } catch (e) {
    sawNotFound = e instanceof NotFoundError
  }
  check(`${uri} unreachable with care.read.user`, !leaked && sawNotFound)
}

// the same records must be reachable WITH the scope, or the partition is just a wall
for (const domain of internalDomains) {
  const uri = uriFor(RAY, domain, 'assistant')
  let ok = false
  try {
    ok = store.read(uri, both).value.length > 0
  } catch {
    ok = false
  }
  check(`${uri} readable with care.read.assistant`, ok)
}

// ── 2. list() must not even reveal that internal records EXIST ────────────────
heading(2, 'existence is not leaked')
const listed = store.list(userOnly).map((x) => x.uri)
const anyInternal = listed.some((u) => u.startsWith('care-internal://'))
check('list() with user scope returns no care-internal:// URI', !anyInternal,
  anyInternal ? listed.filter((u) => u.startsWith('care-internal://')).join(', ') : `${listed.length} user URIs`)

// a wrong-scheme URI must not reach the record either
let crossed = false
try {
  store.read(uriFor(RAY, 'risk', 'user'), userOnly) // risk is assistant-only; ask for it as care://
  crossed = true
} catch { /* expected */ }
check('care:// URI cannot reach an assistant-only record', !crossed)

// ── 3. version chain integrity ───────────────────────────────────────────────
heading(3, 'version chain')
const wb = store.verify(RAY, 'weight_bearing')
check(`weight_bearing chain intact (${wb.versions} versions)`, wb.intact)

store._tamper(RAY, 'weight_bearing', 1, 'Full weight-bearing as tolerated.')
const tampered = store.verify(RAY, 'weight_bearing')
check('tampering v1 breaks the chain and is located', !tampered.intact && tampered.brokenAt === 1,
  tampered.intact ? 'NOT DETECTED' : `broken at v${tampered.brokenAt}`)

// ── 4. staleness is computed, not claimed ────────────────────────────────────
heading(4, 'self-announcing staleness')
const fresh = new LiveResourceStore()
seed(fresh)
const anti = fresh.staleness(uriFor(RAY, 'anticoagulant', 'user'), userOnly, DEMO_NOW)
check('anticoagulant is past its stale_after', anti.stale,
  `stale_after ${anti.staleAfter}, age ${(anti.ageMs / 86_400_000).toFixed(1)}d`)

const ex = fresh.staleness(uriFor(RAY, 'exercise', 'user'), userOnly, DEMO_NOW)
check('exercise (fresh) is NOT flagged stale', !ex.stale,
  `age ${(ex.ageMs / 86_400_000).toFixed(1)}d`)

// ── 5. an audience flip must be refused ──────────────────────────────────────
heading(5, 'audience cannot be changed by a later write')
let flipped = false
try {
  fresh.publish({
    subject: RAY, topic: 'risk', audience: 'user',
    value: 'Fall risk: HIGH.', authorId: 'attacker', authorLabel: 'x',
    writtenAt: new Date().toISOString(),
  })
  flipped = true
} catch { /* expected */ }
check('publishing risk as audience:user is refused', !flipped)

// ── 6. the scope boundary, over a real socket ────────────────────────────────
// Sections 1-5 hold inside one process. None of them is worth anything if the
// HTTP face lets a client name its own scopes, or answers at all without a token.
heading(6, 'OAuth scope boundary over HTTP')

const srv = await createHttpServer({ store: seedDemo(new LiveResourceStore()), announce: false })
const token = (sub: string, scopes: string[]) =>
  mintToken({ sub, scopes, audience: srv.resourceUrl })

const RISK_URI = uriFor(RAY, 'risk', 'assistant')

/**
 * The Alexa+ track's one hard eligibility requirement, verbatim from the rules:
 * "a self-hosted MCP server, implementing MCP spec version 2025-11-25 (minimum)
 * over Streamable HTTP". It is satisfied — but it was satisfied invisibly, asserted
 * by nothing and stated in no document a judge reads, so it had to be inferred from
 * a caret range in package.json. Now it fails loudly if the floor ever drops.
 */
const REQUIRED_PROTOCOL = '2025-11-25'

const noToken = await fetch(`${srv.baseUrl}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
})
check(
  'POST /mcp with no token is refused',
  noToken.status === 401 && (noToken.headers.get('www-authenticate') ?? '').includes('resource_metadata='),
  `HTTP ${noToken.status}`,
)

// A token whose payload was edited to add the assistant scope. The MAC covers the
// payload, so this is the whole attack: it must not survive verification.
const forged = (() => {
  const t = token('attacker', ['care.read.user'])
  const [h, p, sig] = t.split('.') as [string, string, string]
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  claims.scope = 'care.read.user care.read.assistant'
  return `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`
})()
const forgedRes = await fetch(`${srv.baseUrl}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${forged}` },
  body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
})
check('a token with an escalated scope claim is refused', forgedRes.status === 401, `HTTP ${forgedRes.status}`)

let negotiated = ''
async function connect(scopes: string[], sub: string, base = srv.baseUrl) {
  const c = new Client({ name: 'unsay-verify', version: '0.1.0' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token(sub, scopes)}` } },
  })
  await c.connect(transport)
  negotiated = transport.protocolVersion ?? ''
  return c
}

const rayHost = await connect(['care.read.user'], 'echo-show')
let httpLeaked = false
let httpRefused = false
try {
  await rayHost.readResource({ uri: RISK_URI })
  httpLeaked = true
} catch (e) {
  httpRefused = /-32002|not found/i.test(String(e))
}
check(`${RISK_URI} unreachable over HTTP with care.read.user`, !httpLeaked && httpRefused)

// EVERY page. The list is cursor-paginated at three, and checking only the first
// page would let an internal URI hide on page two.
const rayListed: string[] = []
let cursor: string | undefined
do {
  const page = await rayHost.listResources(cursor ? { cursor } : {})
  rayListed.push(...page.resources.map((r) => r.uri))
  cursor = page.nextCursor
} while (cursor)
check(
  'resources/list over HTTP returns no care-internal:// URI, on any page',
  !rayListed.some((u) => u.startsWith('care-internal://')),
  `${rayListed.filter((u) => u.startsWith('care://')).length} care:// URIs + the ui:// card, over every cursor page`,
)

const reasoner = await connect(['care.read.user', 'care.read.assistant'], 'alexa-host')
let readWithScope = false
try {
  readWithScope = (await reasoner.readResource({ uri: RISK_URI })).contents.length > 0
} catch {
  readWithScope = false
}
check(`${RISK_URI} readable over HTTP with care.read.assistant`, readWithScope)

check(
  `the negotiated protocol version is at least ${REQUIRED_PROTOCOL}`,
  negotiated >= REQUIRED_PROTOCOL,
  negotiated || 'nothing negotiated',
)

// The public route must not enumerate what the partition hides. An open port that
// confirms `care-internal://ray/risk` EXISTS has already leaked the thing.
const publicVerify = (await (await fetch(`${srv.baseUrl}/verify`, { headers: { accept: 'application/json' } })).json()) as {
  chains: { uri: string }[]
}
check(
  'GET /verify without a token lists no care-internal:// chain',
  !publicVerify.chains.some((c) => c.uri.startsWith('care-internal://')),
  `${publicVerify.chains.length} public chains`,
)

await rayHost.close()
await reasoner.close()

// ── 7. the AAD binding — the partition survives losing the database ──────────
heading(7, 'encryption at rest binds a ciphertext to its slot')

const envelope = await Envelope.create(
  new LocalKeyProvider(Buffer.from('c'.repeat(64), 'hex')),
  { announce: false },
)
const sealedStore = seedDemo(new LiveResourceStore({ envelope }))

const riskBytes = sealedStore.atRest(RAY, 'risk', 1)
check(
  'the stored value is ciphertext, not the sentence',
  !riskBytes.includes('Fall risk') && Buffer.from(riskBytes, 'base64').length > 0,
  `${Buffer.from(riskBytes, 'base64').length} bytes at rest`,
)

// The attack: an attacker with WRITE access to storage — which no scope check can
// see — moves the never-speakable bytes into the record Alexa reads aloud.
sealedStore._tamper(RAY, 'weight_bearing', 1, riskBytes)
let pasteRead = false
try {
  sealedStore.read(uriFor(RAY, 'weight_bearing', 'user', 1), userOnly)
  pasteRead = true
} catch { /* expected */ }
check('a ciphertext pasted from care-internal://ray/risk fails to decrypt', !pasteRead)

const pasted = sealedStore.verify(RAY, 'weight_bearing')
check(
  'and the chain reports it as broken at that exact version',
  !pasted.intact && pasted.brokenAt === 1 && pasted.expected === '<undecryptable at rest>',
  pasted.intact ? 'NOT DETECTED' : `broken at v${pasted.brokenAt}`,
)

// The same bytes must still open in their own slot, or the test above proves only
// that decryption is broken generally.
const risk1 = { subject: RAY, topic: 'risk', version: 1, audience: 'assistant' as const }
let opensInPlace = false
try {
  opensInPlace = envelope.open(riskBytes, recordAad(risk1)).includes('Fall risk')
} catch { /* stays false */ }
check('the same bytes still open under their own identity', opensInPlace)

// ── 8. the signed clinician write ────────────────────────────────────────────
heading(8, 'the write path refuses what it cannot verify')

const writeSecret = process.env.UNSAY_WRITE_SECRET ?? DEV_WRITE_SECRET
const body = Buffer.from(
  JSON.stringify({
    patient: RAY,
    domain: 'weight_bearing',
    audience: 'user',
    value: 'Full weight-bearing as tolerated.',
    authorId: 'okafor',
    authorLabel: 'Sarah Okafor, physio',
  }),
  'utf8',
)

// `Buffer<ArrayBuffer>`, not bare `Buffer`: the bare form widens to
// `Buffer<ArrayBufferLike>`, which `fetch`'s BodyInit does not accept.
const post = (b: Buffer<ArrayBuffer>, headers: Record<string, string>) =>
  fetch(`${srv.baseUrl}/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: b,
  })

const ts = new Date().toISOString()
const goodSig = signWriteBody(writeSecret, ts, body)
const rejectedBefore = srv.audit.rejected().length

const unsigned = await post(body, {})
check('an unsigned write is refused', unsigned.status === 401, `HTTP ${unsigned.status}`)

// One byte changed AFTER signing. This is the check that has to be done over the
// raw request bytes: verifying against a re-serialised parse of the body is how
// signed webhooks get forged.
const mutated = Buffer.from(body.toString('utf8').replace('Full', 'Non-'))
const tamperedWrite = await post(mutated, { 'x-unsay-timestamp': ts, 'x-unsay-signature': goodSig })
check('a body mutated after signing is refused', tamperedWrite.status === 401, `HTTP ${tamperedWrite.status}`)

const wrongKey = await post(body, {
  'x-unsay-timestamp': ts,
  'x-unsay-signature': signWriteBody('not-the-write-secret', ts, body),
})
check('a signature under the wrong key is refused', wrongKey.status === 401, `HTTP ${wrongKey.status}`)

// The timestamp is inside the signed material, so a captured request cannot be
// re-dated — and outside the skew window it is refused regardless.
const oldTs = new Date(Date.now() - WRITE_SKEW_MS - 60_000).toISOString()
const replayed = await post(body, {
  'x-unsay-timestamp': oldTs,
  'x-unsay-signature': signWriteBody(writeSecret, oldTs, body),
})
check('a correctly signed but stale request is refused', replayed.status === 401, `HTTP ${replayed.status}`)

const accepted = await post(body, { 'x-unsay-timestamp': ts, 'x-unsay-signature': goodSig })
const written = accepted.ok ? ((await accepted.json()) as { version: number }) : null
check('a correctly signed write is accepted', accepted.status === 200 && !!written, `HTTP ${accepted.status}`)

check(
  'every refusal left an audit row',
  srv.audit.rejected().length === rejectedBefore + 4,
  `${srv.audit.rejected().length - rejectedBefore} rows for 4 refusals`,
)

// A rejected write is the row that matters, and it must not be a place a stolen
// credential can come to rest.
const auditText = JSON.stringify(srv.audit.rows())
check(
  'no audit row carries a credential, a MAC or a bearer token',
  !auditText.includes(writeSecret) &&
    !auditText.includes(goodSig) &&
    !/[0-9a-f]{64}/.test(auditText) &&
    !/Bearer /.test(auditText),
)

// A uniform 401 everywhere: a response that named the failing check would tell an
// attacker whether the key or the clock was wrong.
const shapes = new Set(
  await Promise.all([unsigned, tamperedWrite, wrongKey, replayed].map((r) => r.clone().text())),
)
check('every refusal returns the same body, naming no cause', shapes.size === 1, [...shapes][0] ?? '')

await srv.close()

// ── 9. the clock the ENTRYPOINT actually runs on ─────────────────────────────
/**
 * Every gate above passes an explicit clock, which is exactly how a clock defect
 * hides: `npm start` builds its own store and its own `now`, and nothing exercised
 * that pair. It seeded at the pinned DEMO_NOW and read the wall clock, so the one
 * command DEMO.md sends a judge to served `[changed -32d ago by …]` and the
 * self-announcing-staleness feature was dead on the live process. LESSONS R11: a
 * green suite over a product that misbehaves for a stranger.
 *
 * So this section takes NO store and NO clock — the defaults `scripts/serve.ts`
 * uses — and reads the headers a judge would see.
 */
heading(9, 'the live entrypoint serves an honest age')

const liveSrv = await createHttpServer({ announce: false })
const liveClient = new Client({ name: 'unsay-verify-live', version: '0.1.0' }, { capabilities: {} })
await liveClient.connect(
  new StreamableHTTPClientTransport(new URL(`${liveSrv.baseUrl}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${mintToken({
          sub: 'echo-show',
          scopes: ['care.read.user'],
          audience: liveSrv.resourceUrl,
        })}`,
      },
    },
  }),
)

const headerOf = async (uri: string) => {
  const r = await liveClient.readResource({ uri })
  return (r.contents[0] as { text: string }).text.split('\n')[0]!
}

const liveHeaders: string[] = []
for (const domain of ['weight_bearing', 'anticoagulant', 'exercise', 'contact']) {
  liveHeaders.push(await headerOf(uriFor(RAY, domain, 'user')))
}
const negative = liveHeaders.filter((h) => /-\d+\s*d(ay)? ago/.test(h))
check(
  'no resource reports a negative age on the default clock',
  negative.length === 0,
  negative.length ? negative.join(' | ') : `${liveHeaders.length} headers, all forward in time`,
)

const antiLive = await headerOf(uriFor(RAY, 'anticoagulant', 'user'))
check('the anticoagulant record is past its review date on the default clock',
  antiLive.startsWith('[STALE'), antiLive)

const exLive = await headerOf(uriFor(RAY, 'exercise', 'user'))
check('a fresh record is NOT flagged stale on the default clock',
  exLive.startsWith('[changed'), exLive)

await liveClient.close()
await liveSrv.close()

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing assertion(s)`)

mkdirSync('docs/proof', { recursive: true })
writeFileSync(
  'docs/proof/verify.json',
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      assertions: asserted.length,
      failing: failures,
      // Named so a reader can see the shape of the split the README quotes: the
      // guarantees that hold in one process, and the ones that only exist behind
      // a socket.
      inProcess: asserted.filter((a) => !OVER_HTTP.has(a.section)).length,
      overHttp: asserted.filter((a) => OVER_HTTP.has(a.section)).length,
      checks: asserted,
      verdict: failures === 0 ? 'PASS' : 'FAIL',
    },
    null,
    2,
  ) + '\n',
)
console.log('receipt → docs/proof/verify.json')
process.exit(failures === 0 ? 0 : 1)
