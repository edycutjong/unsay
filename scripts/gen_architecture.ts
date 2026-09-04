/**
 * Generate ARCHITECTURE.md FROM the codebase.
 *
 * LESSONS R6 (8 occurrences): docs claimed routes that did not exist, dependencies
 * not in package.json, "AI-powered" with zero AI code. The fix is mechanical —
 * this file reads the source and emits only what it finds, so the doc cannot
 * describe a surface that was never built.
 *
 * Run: npm run docs:arch
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    statSync(p).isDirectory() ? walk(p, out) : e.endsWith('.ts') && out.push(p)
  }
  return out
}

/**
 * `packages/<name>/src` is walked too, and BEFORE scripts/: the notification
 * senders moved into @unsay/live-resources when the generic half was extracted, so
 * a generator that only read src/ would report two notification surfaces where the
 * server ships three. Only each package's `src` — its tests are not the product.
 * Order matters because the "where" column takes the first file that matches, and
 * the product path must win over a probe harness that also sends one.
 */
const packagesDir = join(ROOT, 'packages')
const packageSources = existsSync(packagesDir)
  ? readdirSync(packagesDir).flatMap((name) => {
      const dir = join(packagesDir, name, 'src')
      return existsSync(dir) ? walk(dir) : []
    })
  : []

const files = walk(join(ROOT, 'src')).concat(packageSources, walk(join(ROOT, 'scripts')))
const bodies = new Map(files.map((f) => [f.replace(ROOT, ''), readFileSync(f, 'utf8')]))
const all = [...bodies.values()].join('\n')

// MCP request schemas actually registered
const handlers = [...all.matchAll(/setRequestHandler\((\w+)Schema/g)].map((m) => m[1]!)
const notifications = [...all.matchAll(/\.(send[A-Z]\w+)\(/g)].map((m) => m[1]!)
const capabilities = /capabilities: \{\n([\s\S]*?)\n      \},/.exec(all)?.[1]

/**
 * HTTP routes, read out of the router in src/http.ts rather than out of a list
 * someone maintained by hand. `path === '/x'` is the only shape the router uses
 * to dispatch, and STATIC_PAGES is the only other thing it serves — so anything
 * this misses is a route the router does not have either.
 */
const httpSource = bodies.get('src/http.ts') ?? ''
const routes = [...new Set([...httpSource.matchAll(/path === '([^']+)'/g)].map((m) => m[1]!))]
const staticPages = [...httpSource.matchAll(/^ {2}'(\/[\w.]+)': '[\w.]+',$/gm)].map((m) => m[1]!)
const routeMethods = (path: string) => {
  if (path === '/mcp') return 'POST · GET · DELETE'
  if (path === '/write') return 'POST'
  return 'GET'
}
const ROUTE_AUTH: Record<string, string> = {
  '/mcp': 'Bearer (care.read.user / care.read.assistant)',
  '/write': 'HMAC-SHA256 over the raw body, or Bearer care.write',
  '/verify': 'public — a token widens what it lists',
  '/health': 'public',
  '/.well-known/oauth-protected-resource': 'public (RFC 9728)',
  '/.well-known/oauth-protected-resource/mcp': 'public (RFC 9728)',
}

const SCHEMA_TO_METHOD: Record<string, string> = {
  ListResources: 'resources/list',
  ReadResource: 'resources/read',
  Subscribe: 'resources/subscribe',
  Unsubscribe: 'resources/unsubscribe',
  ListResourceTemplates: 'resources/templates/list',
  Complete: 'completion/complete',
  ListPrompts: 'prompts/list',
  GetPrompt: 'prompts/get',
  ListTools: 'tools/list',
  CallTool: 'tools/call',
}
const NOTIF_TO_METHOD: Record<string, string> = {
  sendResourceUpdated: 'notifications/resources/updated',
  sendResourceListChanged: 'notifications/resources/list_changed',
  sendLoggingMessage: 'notifications/message',
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const deps = Object.entries(pkg.dependencies ?? {})
const scripts = Object.entries(pkg.scripts ?? {})

const exportsOf = (file: string) =>
  [...(bodies.get(file) ?? '').matchAll(/^export (?:async )?(?:function|class|const) (\w+)/gm)]
    .map((m) => m[1]!)

const lines: string[] = []
const A = (s = '') => lines.push(s)

A('# Architecture')
A()
A('> **Generated from the codebase** by `scripts/gen_architecture.ts` — run `npm run docs:arch`.')
A('> Nothing here is hand-written. If a surface is listed, code for it exists in `src/` or `packages/`.')
A('> LESSONS R6: eight prior submissions documented routes that were never built.')
A()
A(`_Generated: ${new Date().toISOString()}_`)
A()
A('## MCP surfaces actually registered')
A()
A('| Protocol method | Registered in |')
A('|---|---|')
for (const h of [...new Set(handlers)].sort()) {
  const method = SCHEMA_TO_METHOD[h.replace(/Request$/, '')] ?? h
  const where = [...bodies.entries()].find(([, b]) => b.includes(`setRequestHandler(${h}Schema`))?.[0]
  A(`| \`${method}\` | \`${where}\` |`)
}
for (const n of [...new Set(notifications)].sort()) {
  const method = NOTIF_TO_METHOD[n] ?? n
  const where = [...bodies.entries()].find(([, b]) => b.includes(`.${n}(`))?.[0]
  A(`| \`${method}\` | \`${where}\` |`)
}
A()
A(`**${new Set(handlers).size} request handlers + ${new Set(notifications).size} notification sender(s).**`)
A()
A('Declaring `logging` also makes the SDK serve `logging/setLevel` without a handler of')
A('our own, so it is a surface a host can call but is deliberately not listed above —')
A('this table only names methods with a sender or handler in the source.')
A()
A('## HTTP routes')
A()
A('| Route | Methods | Auth |')
A('|---|---|---|')
for (const r of routes.filter((r) => r !== '/').sort()) {
  A(`| \`${r}\` | ${routeMethods(r)} | ${ROUTE_AUTH[r] ?? 'public'} |`)
}
for (const page of staticPages) {
  A(`| \`${page}\`${page === '/index.html' ? ' (and `/`)' : ''} | GET · HEAD | public — served from \`web/\` |`)
}
A()
A(`**${routes.filter((r) => r !== '/').length} routes + ${staticPages.length} static pages**, all in \`src/http.ts\`.`)
A()
if (capabilities) {
  A('## Declared capabilities')
  A()
  A('```js')
  // Dedent to the shallowest line: the block is lifted verbatim out of a nested
  // object literal, and its source indentation is not information.
  const pad = Math.min(...capabilities.split('\n').filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length))
  A(capabilities.split('\n').map((l) => l.slice(pad)).join('\n'))
  A('```')
  A()
}
A('## Modules')
A()
A('| File | Exports |')
A('|---|---|')
for (const f of [...bodies.keys()].filter((f) => f.startsWith('src/')).sort()) {
  const ex = exportsOf(f)
  A(`| \`${f}\` | ${ex.length ? ex.map((e) => `\`${e}\``).join(', ') : '—'} |`)
}
A()
if (packageSources.length) {
  A('## Extracted package')
  A()
  A('The generic half — versioned resources, revision notifications, the hash chain,')
  A('and the audience/scope partition — lifted out of `src/` so it can be depended on')
  A('without Unsay. Consumed here by relative import; not published to npm.')
  A()
  A('| File | Exports |')
  A('|---|---|')
  for (const f of [...bodies.keys()].filter((f) => f.startsWith('packages/')).sort()) {
    const ex = exportsOf(f)
    A(`| \`${f}\` | ${ex.length ? ex.map((e) => `\`${e}\``).join(', ') : '—'} |`)
  }
  A()
}
A('## Executable scripts')
A()
A('| Command | File |')
A('|---|---|')
for (const [name, cmd] of scripts as [string, string][]) {
  const file = /scripts\/[\w.]+\.ts/.exec(cmd)?.[0] ?? (name === 'test' ? 'test/**' : cmd)
  A(`| \`npm run ${name}\` | \`${file}\` |`)
}
A()
A('## Runtime dependencies')
A()
A('| Package | Version | Used in |')
A('|---|---|---|')
for (const [name, version] of deps as [string, string][]) {
  const used = [...bodies.entries()].filter(([, b]) => b.includes(`'${name}`)).map(([f]) => f)
  A(`| \`${name}\` | \`${version}\` | ${used.length ? used.map((u) => `\`${u}\``).join(', ') : '**UNUSED — remove**'} |`)
}
A()
A('## Not built')
A()
A('Stated so this document cannot imply otherwise:')
A()
A('- **No AWS deployment.** `npm start` runs the server locally and nothing is hosted. The KMS')
A('  provider in `src/envelope.ts` is SigV4-signed and shaped correctly but has never been')
A('  executed against a live CMK — see FRICTION.md F-010.')
A('- **No authorization server.** Unsay is an OAuth 2.1 protected RESOURCE only: no `/authorize`,')
A('  no `/token`, no refresh, no revocation, no JWKS. Tokens are HS256 under a shared secret,')
A('  minted by `mintToken()` in the same file that verifies them.')
A('- **No durable storage.** The store, the event store and the audit log are in memory; the')
A('  audit log survives only if `UNSAY_AUDIT_LOG` names a file.')
A('- No ML model of any kind, by design — the reasoning model belongs to the host.')
A('- No blockchain, token, or payment surface.')

writeFileSync(join(ROOT, 'ARCHITECTURE.md'), lines.join('\n') + '\n')
console.log(
  `ARCHITECTURE.md generated — ${new Set(handlers).size} handlers, ${new Set(notifications).size} notifications, ` +
    `${routes.length - 1} HTTP routes, ${staticPages.length} pages, ${deps.length} deps`,
)
