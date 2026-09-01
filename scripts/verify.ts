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
 * Run: npm run verify
 */
import { LiveResourceStore, NotFoundError, uriFor } from '../src/store.ts'
import { seed, RAY, DEMO_NOW } from '../src/seed.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
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
console.log('1. audience partition')
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
console.log('\n2. existence is not leaked')
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
console.log('\n3. version chain')
const wb = store.verify(RAY, 'weight_bearing')
check(`weight_bearing chain intact (${wb.versions} versions)`, wb.intact)

store._tamper(RAY, 'weight_bearing', 1, 'Full weight-bearing as tolerated.')
const tampered = store.verify(RAY, 'weight_bearing')
check('tampering v1 breaks the chain and is located', !tampered.intact && tampered.brokenAt === 1,
  tampered.intact ? 'NOT DETECTED' : `broken at v${tampered.brokenAt}`)

// ── 4. staleness is computed, not claimed ────────────────────────────────────
console.log('\n4. self-announcing staleness')
const fresh = new LiveResourceStore()
seed(fresh)
const anti = fresh.staleness(uriFor(RAY, 'anticoagulant', 'user'), userOnly, DEMO_NOW)
check('anticoagulant is past its stale_after', anti.stale,
  `stale_after ${anti.staleAfter}, age ${(anti.ageMs / 86_400_000).toFixed(1)}d`)

const ex = fresh.staleness(uriFor(RAY, 'exercise', 'user'), userOnly, DEMO_NOW)
check('exercise (fresh) is NOT flagged stale', !ex.stale,
  `age ${(ex.ageMs / 86_400_000).toFixed(1)}d`)

// ── 5. an audience flip must be refused ──────────────────────────────────────
console.log('\n5. audience cannot be changed by a later write')
let flipped = false
try {
  fresh.publish({
    patient: RAY, domain: 'risk', audience: 'user',
    value: 'Fall risk: HIGH.', authorId: 'attacker', authorLabel: 'x',
    writtenAt: new Date().toISOString(),
  })
  flipped = true
} catch { /* expected */ }
check('publishing risk as audience:user is refused', !flipped)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing assertion(s)`)
process.exit(failures === 0 ? 0 : 1)
