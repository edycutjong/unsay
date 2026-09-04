/**
 * seed — print the demo dataset, and prove it is deterministic.
 *
 * The version hash chain is the staleness proof. It is only a proof if the same
 * seed produces the same hashes on your machine and on a judge's, so this seeds
 * the store TWICE and compares every hash before printing anything. A seed that
 * drifted with wall-clock time would make every `prevHash → versionHash` claim in
 * the product unverifiable, and would do it silently.
 *
 * Run: npm run seed            (add --json for the raw records)
 */
import { LiveResourceStore, parseUri } from '../src/store.ts'
import { DEMO_NOW, RAY, STAGED_REVISION, seedDemo } from '../src/seed.ts'
import { SCOPE } from '../src/types.ts'

const both = { sub: 'seed-dump', scopes: [SCOPE.user, SCOPE.assistant] }

const a = seedDemo(new LiveResourceStore())
const b = seedDemo(new LiveResourceStore())

const chainsOf = (store: LiveResourceStore) =>
  store
    .list(both)
    .map(({ uri }) => uri)
    .sort()
    .map((uri) => {
      const { patient, domain } = parseUri(uri)!
      return { uri, versions: store.versions(patient, domain) }
    })

const A = chainsOf(a)
const B = chainsOf(b)

const drift = A.flatMap((chain, i) =>
  chain.versions
    .filter((r, j) => r.versionHash !== B[i]?.versions[j]?.versionHash)
    .map((r) => `${chain.uri}/v${r.version}`),
)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ demoNow: DEMO_NOW.toISOString(), chains: A, drift }, null, 2))
} else {
  console.log(`unsay · seed · Ray Dunn, day 5 after a hip replacement\n`)
  console.log(`  pinned clock  ${DEMO_NOW.toISOString()}\n`)
  for (const { uri, versions } of A) {
    console.log(`  ${uri}`)
    for (const r of versions) {
      console.log(
        `    v${r.version}  ${r.versionHash.slice(0, 12)}…  prev ${
          r.prevHash ? r.prevHash.slice(0, 12) + '…' : '—'.padEnd(13)
        }  ${r.authorLabel}`,
      )
      console.log(`         ${r.value}`)
    }
    console.log('')
  }
  console.log(`  NOT seeded — fired live on stage:`)
  console.log(`    care://${RAY}/${STAGED_REVISION.domain}  "${STAGED_REVISION.value}"\n`)
}

const total = A.reduce((n, c) => n + c.versions.length, 0)
// A comparison over zero versions is green and means nothing. Say so and fail.
const vacuous = total === 0
console.log(
  vacuous
    ? `  NOTHING COMPARED — the seed produced ${A.length} chains and no versions`
    : drift.length === 0
      ? `  DETERMINISTIC — ${A.length} chains, ${total} versions, identical hashes across two seeds`
      : `  NOT DETERMINISTIC — ${drift.length} version(s) drifted: ${drift.join(', ')}`,
)
process.exit(!vacuous && drift.length === 0 ? 0 : 1)
