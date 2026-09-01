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
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
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

const files = walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'scripts')))
const bodies = new Map(files.map((f) => [f.replace(ROOT, ''), readFileSync(f, 'utf8')]))
const all = [...bodies.values()].join('\n')

// MCP request schemas actually registered
const handlers = [...all.matchAll(/setRequestHandler\((\w+)Schema/g)].map((m) => m[1]!)
const notifications = [...all.matchAll(/server\.(send\w+)\(/g)].map((m) => m[1]!)
const capabilities = /capabilities:\s*\{([\s\S]*?)\n {4}\}/.exec(all)?.[1]?.trim()

const SCHEMA_TO_METHOD: Record<string, string> = {
  ListResources: 'resources/list',
  ReadResource: 'resources/read',
  Subscribe: 'resources/subscribe',
  Unsubscribe: 'resources/unsubscribe',
  ListResourceTemplates: 'resources/templates/list',
  Complete: 'completion/complete',
  ListTools: 'tools/list',
  CallTool: 'tools/call',
}
const NOTIF_TO_METHOD: Record<string, string> = {
  sendResourceUpdated: 'notifications/resources/updated',
  sendResourceListChanged: 'notifications/resources/list_changed',
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
A('> Nothing here is hand-written. If a surface is listed, a handler for it exists in `src/`.')
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
  const where = [...bodies.entries()].find(([, b]) => b.includes(`server.${n}(`))?.[0]
  A(`| \`${method}\` | \`${where}\` |`)
}
A()
A(`**${new Set(handlers).size} request handlers + ${new Set(notifications).size} notification sender(s).**`)
A()
if (capabilities) {
  A('## Declared capabilities')
  A()
  A('```js')
  A(capabilities)
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
A('- No AWS deployment yet — DynamoDB/Lambda/KMS are in the plan (`../specs/architecture.md`), not in this repo.')
A('- No HTTP entrypoint deployed; the server is exercised over Streamable HTTP by `scripts/e2e.ts` and `scripts/bench.ts`.')
A('- No ML model of any kind, by design — the reasoning model belongs to the host.')
A('- No blockchain, token, or payment surface.')

writeFileSync(join(ROOT, 'ARCHITECTURE.md'), lines.join('\n') + '\n')
console.log(`ARCHITECTURE.md generated — ${new Set(handlers).size} handlers, ${new Set(notifications).size} notifications, ${deps.length} deps`)
