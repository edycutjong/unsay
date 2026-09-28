/**
 * The five prose documents, rendered as pages instead of handed over as source.
 *
 * `/README.md` and its four siblings were served `text/plain`, so every link in the
 * landing page's footer and two of its Proof cards dropped a judge into ~150 kB of
 * raw markdown in the browser's default serif, edge to edge, with none of the
 * page's typography — `**Date:**`, backticked spans and `---` rules and all. The
 * allowlist test asserted each path "returns 200 with the expected content", which
 * was true and green the whole time (LESSONS R11: a passing test over something
 * that does not work for a stranger).
 *
 * So this renders them at `/doc/<name>` with the landing page's own tokens. The raw
 * paths stay in the allowlist — `curl` should still get the source — and the `.ts`
 * enforcement-point links stay `text/plain` on purpose, because a judge following
 * one wants to READ code, not a rendering of it.
 *
 * The renderer is a deliberate subset: headings, fenced code, tables, lists,
 * blockquotes, rules, and the four inline forms these documents actually use. It
 * escapes everything by default and passes through only the handful of raw-HTML
 * block forms README.md contains (a centered `div`, two `img`s, an anchor). No
 * dependency, and nothing here can render a tag a document did not write.
 */

/** One rendered document: the file it reads, and the title the tab carries. */
export interface DocPage {
  file: string
  title: string
}

export const DOC_PAGES: Record<string, DocPage> = {
  '/doc/readme': { file: 'README.md', title: 'Unsay — README' },
  '/doc/demo': { file: 'DEMO.md', title: 'Unsay — reproduce everything' },
  '/doc/architecture': { file: 'ARCHITECTURE.md', title: 'Unsay — architecture' },
  '/doc/friction': { file: 'FRICTION.md', title: 'Unsay — friction log' },
  '/doc/spec': { file: 'docs/SPEC.md', title: 'Unsay — spec & threat model' },
}

/**
 * Repo-relative link → the route this server answers it on.
 *
 * A link this table does not know is rendered as plain code rather than as an
 * anchor: the pages' standing rule is never to render a link that goes nowhere,
 * and a `.ts` path that is not on the allowlist would 404 under `npm start`.
 */
const LINK_ROUTES: Record<string, string> = {
  'README.md': '/doc/readme',
  'DEMO.md': '/doc/demo',
  'ARCHITECTURE.md': '/doc/architecture',
  'FRICTION.md': '/doc/friction',
  'docs/SPEC.md': '/doc/spec',
  'web/index.html': '/index.html',
  'web/echo.html': '/echo.html',
  'web/clinician.html': '/clinician.html',
  'skill/SKILL.md': '/skill/SKILL.md',
  'LICENSE': '/LICENSE',
  'docs/assets/icon.svg': '/icon.svg',
  'docs/assets/og-image.png': '/og.png',
  'docs/assets/readme-hero-animated.svg': '/docs/assets/readme-hero-animated.svg',
  'docs/assets/icon-animated.svg': '/docs/assets/icon-animated.svg',
  'docs/proof/bench.txt': '/docs/proof/bench.txt',
  'docs/proof/bench.json': '/docs/proof/bench.json',
  'docs/proof/verify.json': '/docs/proof/verify.json',
  'docs/proof/live_run.jsonl': '/docs/proof/live_run.jsonl',
  'docs/proof/probe_subscribe.json': '/docs/proof/probe_subscribe.json',
  'docs/proof/resume.json': '/docs/proof/resume.json',
  'packages/live-resources/src/store.ts': '/packages/live-resources/src/store.ts',
  'src/server.ts': '/src/server.ts',
  'src/http.ts': '/src/http.ts',
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * GitHub's heading slug, near enough for the in-document anchors these files use
 * (`#what-is-not-here`, `#the-number`): lowercase, drop anything that is not a
 * word character or a space, spaces to hyphens. Emoji in a heading fall out here,
 * which is why `## 📄 License` still answers `#license`.
 */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`|\*\*|\*|_/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Resolve a markdown link target, or null when this server serves nothing there. */
export function resolveDocLink(href: string): string | null {
  if (/^(?:https?:|mailto:|#)/.test(href)) return href
  const [path, anchor] = href.split('#') as [string, string | undefined]
  if (!path) return href
  const route = LINK_ROUTES[path.replace(/^\.\//, '')]
  if (!route) return null
  return anchor ? `${route}#${anchor}` : route
}

/** Inline markdown: code, bold, italic, links. Applied to already-escaped text. */
function inline(text: string): string {
  const codes: string[] = []
  // Code spans are lifted out first so a backticked `**` or `[x](y)` inside one is
  // shown rather than interpreted — these documents are full of both.
  let out = esc(text).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  // Images first: a badge row is `[![alt](img)](href)`, and the link rule below
  // then sees an `<img>` as its label, which is exactly what it should link.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    const target = resolveDocLink(src.replace(/&amp;/g, '&'))
    return target ? `<img src="${esc(target)}" alt="${alt}">` : ''
  })
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const target = resolveDocLink(href.replace(/&amp;/g, '&'))
    return target ? `<a href="${esc(target)}">${label}</a>` : `<span class="unlinked">${label}</span>`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]!)
}

/**
 * The raw-HTML block forms README.md actually contains. Anything else that starts
 * with `<` is escaped and shown, so a document cannot smuggle markup through here.
 */
function rawBlock(line: string): string | null {
  if (/^<!--[\s\S]*-->$/.test(line)) return ''
  if (/^<div\s+align="center">$/.test(line)) return '<div class="center">'
  if (line === '</div>') return '</div>'
  if (/^<a\s+id="[\w-]+"><\/a>$/.test(line)) {
    return `<span id="${/id="([\w-]+)"/.exec(line)![1]}"></span>`
  }
  const img = /^<img\s+src="([^"]+)"\s+alt="([^"]*)"(?:\s+width="(\d+)")?(?:\s+height="(\d+)")?\s*>$/
    .exec(line)
  if (img) {
    const src = resolveDocLink(img[1]!) ?? img[1]!
    const w = img[3] ? ` width="${img[3]}"` : ''
    const h = img[4] ? ` height="${img[4]}"` : ''
    return `<img src="${esc(src)}" alt="${esc(img[2]!)}"${w}${h}>`
  }
  return null
}

/** Markdown subset → HTML body. */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  let listTag: 'ul' | 'ol' | null = null
  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = null } }

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      closeList()
      const lang = trimmed.slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) body.push(lines[i++]!)
      i++
      out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }

    if (!trimmed) { closeList(); i++; continue }

    const raw = trimmed.startsWith('<') ? rawBlock(trimmed) : null
    if (raw !== null) { closeList(); if (raw) out.push(raw); i++; continue }

    if (/^(?:---+|\*\*\*+)$/.test(trimmed)) { closeList(); out.push('<hr>'); i++; continue }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      closeList()
      const level = heading[1]!.length
      const text = heading[2]!
      out.push(`<h${level} id="${esc(slugify(text))}">${inline(text)}</h${level}>`)
      i++
      continue
    }

    // A table: a pipe row followed by a `|---|` separator row.
    if (trimmed.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? '')) {
      closeList()
      const cells = (row: string) =>
        row.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
      const head = cells(trimmed)
      i += 2
      const body: string[][] = []
      while (i < lines.length && lines[i]!.trim().startsWith('|')) body.push(cells(lines[i++]!))
      out.push(
        '<div class="tw"><table><thead><tr>' +
          head.map((c) => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
      )
      continue
    }

    if (trimmed.startsWith('> ') || trimmed === '>') {
      closeList()
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        body.push(lines[i]!.trim().replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${inline(body.join(' ').trim())}</blockquote>`)
      continue
    }

    const item = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(trimmed)
    if (item) {
      const wanted = /^\d/.test(trimmed) ? 'ol' : 'ul'
      if (listTag !== wanted) { closeList(); out.push(`<${wanted}>`); listTag = wanted }
      // Continuation lines of one item are indented; fold them into it.
      const body = [item[1]!]
      i++
      while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? '') && !/^\s*[-*]\s/.test(lines[i]!)) {
        body.push(lines[i]!.trim())
        i++
      }
      out.push(`<li>${inline(body.join(' '))}</li>`)
      continue
    }

    // Always consumes the current line, so an HTML block form this renderer does
    // not know is shown as escaped text rather than silently dropped — and the
    // loop cannot fail to make progress.
    closeList()
    const para: string[] = [trimmed]
    i++
    while (i < lines.length && lines[i]!.trim() && !/^(?:```|#{1,6}\s|>|\||---|<)/.test(lines[i]!.trim())) {
      para.push(lines[i]!.trim())
      i++
    }
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  closeList()
  return out.join('\n')
}

/**
 * The page shell. The token block is the landing page's, verbatim in intent: a
 * document that opens in a different typeface from the page that linked to it
 * reads as a different site.
 */
const SHELL_CSS = `
:root{
  --bg:#0B0D0E; --surface:#16191B; --raise:#1D2124; --line:#262B2E; --line-soft:#1F2426;
  --text:#F2F4F5; --muted:#9BA3A8; --dim:#838C91;
  --amber:#F2A93B; --red-ink:#E4695E; --green-ink:#5CB77E;
  --accent:#5B8DEF; --accent-ink:#7FA6F3; --focus:#7FA6F3;
}
@media (prefers-color-scheme: light){
  :root{
    --bg:#F3F5F6; --surface:#FFFFFF; --raise:#F7F9FA; --line:#DDE2E5; --line-soft:#E7EBEE;
    --text:#0B0D0E; --muted:#535E64; --dim:#5F6B71;
    --amber:#DE8F13; --red-ink:#9E2C20; --green-ink:#1F5D38;
    --accent:#2C55C4; --accent-ink:#1F44AB; --focus:#2C55C4;
  }
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0; background:var(--bg); color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  font-size:17px; line-height:1.62; letter-spacing:-0.005em; -webkit-font-smoothing:antialiased}
nav{position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:2px 18px; align-items:baseline;
  padding:14px 24px; background:color-mix(in srgb,var(--bg) 92%,transparent);
  backdrop-filter:blur(8px); border-bottom:1px solid var(--line-soft); font-size:14px}
nav .brand{font-weight:600; letter-spacing:-0.02em; margin-right:6px}
nav a{color:var(--muted); border-bottom:none}
nav a:hover,nav a[aria-current]{color:var(--text)}
main{max-width:74ch; margin:0 auto; padding:36px 24px 96px}
h1,h2,h3,h4,h5,h6{letter-spacing:-0.022em; line-height:1.18; margin:2em 0 .55em}
h1{font-size:2.05em; margin-top:.4em} h2{font-size:1.42em} h3{font-size:1.14em}
h4,h5,h6{font-size:1em; color:var(--muted)}
h2{padding-top:.55em; border-top:1px solid var(--line-soft)}
p{margin:0 0 1.05em}
a{color:var(--accent-ink); text-decoration:none; border-bottom:1px solid color-mix(in srgb,var(--accent) 40%,transparent)}
a:hover{border-bottom-color:var(--accent)}
:where(a):focus-visible{outline:2px solid var(--focus); outline-offset:3px; border-radius:3px}
.unlinked{color:var(--muted)}
code{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace; font-size:.84em;
  background:var(--raise); border:1px solid var(--line-soft); border-radius:4px; padding:1px 5px}
pre{overflow-x:auto; background:var(--surface); border:1px solid var(--line); border-radius:10px;
  padding:14px 16px; margin:0 0 1.3em; line-height:1.5}
pre code{background:none; border:none; padding:0; font-size:12.8px; white-space:pre}
blockquote{margin:0 0 1.3em; padding:2px 0 2px 18px; border-left:3px solid var(--amber); color:var(--muted)}
ul,ol{margin:0 0 1.1em; padding-left:1.35em}
li{margin:.3em 0}
hr{border:none; border-top:1px solid var(--line-soft); margin:2.4em 0}
.tw{overflow-x:auto; margin:0 0 1.4em; border:1px solid var(--line); border-radius:10px}
table{border-collapse:collapse; width:100%; font-size:14.5px}
th,td{text-align:left; vertical-align:top; padding:9px 13px; border-bottom:1px solid var(--line-soft)}
th{color:var(--dim); font-weight:600; font-size:12.5px; letter-spacing:.06em; text-transform:uppercase;
  background:var(--raise); white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
.center{text-align:center}
.center img{max-width:100%; height:auto}
.center p img{vertical-align:middle; margin:2px 3px}
img{max-width:100%; height:auto}
.src{margin:2.6em 0 0; padding-top:1.2em; border-top:1px solid var(--line-soft);
  font-size:13.5px; color:var(--dim)}
@media (max-width:600px){ body{font-size:16px} main{padding:24px 18px 72px} }
@media (prefers-reduced-motion: reduce){ *{animation:none !important; transition:none !important} }
`

const NAV = [
  ['/index.html', 'Overview'],
  ['/doc/readme', 'README'],
  ['/doc/demo', 'Demo'],
  ['/doc/architecture', 'Architecture'],
  ['/doc/spec', 'Spec'],
  ['/doc/friction', 'Friction'],
] as const

/**
 * A whole page for one document. `rawPath` is the plain-text original, kept
 * visible at the foot so `curl` and a diff still have somewhere obvious to go.
 */
export function renderDocPage(markdown: string, opts: { title: string; path: string; rawPath: string }): string {
  const nav = NAV.map(([href, label]) =>
    `<a href="${href}"${href === opts.path ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="color-scheme" content="dark light">
<meta name="robots" content="index, follow">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>${SHELL_CSS}</style>
</head>
<body>
<nav><span class="brand">unsay</span>${nav}</nav>
<main>
${renderMarkdown(markdown)}
<p class="src">Rendered from <code>${esc(opts.rawPath.replace(/^\//, ''))}</code> in the repository.
Source as text: <a href="${esc(opts.rawPath)}">${esc(opts.rawPath)}</a>.</p>
</main>
</body>
</html>
`
}
