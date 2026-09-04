/**
 * The entrypoint. `npm start` runs this.
 *
 * Everything else in this repo either runs and exits (the probes, the bench, the
 * e2e) or is a library. This is the one long-running process: the MCP server, the
 * OAuth protected resource, the clinician write path, the public /verify route,
 * and the three pages in web/ — all on ONE origin, because a browser blocks a
 * cross-origin fetch before it leaves and a judge should need one URL, not two.
 *
 * It prints ready-to-click links carrying a freshly minted token, so nobody has
 * to hand-assemble a credential to see the product work.
 *
 * Run: npm start          (PORT=39500 by default — what the pages expect)
 */
import { DEV_WRITE_SECRET, createHttpServer, mintToken } from '../src/http.ts'

/** The pages' built-in default, so `npm start` and an opened file agree with no flags. */
const PORT = Number(process.env.PORT ?? 39_500)
const HOST = process.env.HOST ?? '127.0.0.1'

const srv = await createHttpServer({ port: PORT, host: HOST })

/** One hour, the mintToken default. Long enough for a demo, short enough to be a token. */
const token = (sub: string, scopes: string[]) =>
  mintToken({ sub, scopes, audience: srv.resourceUrl })

const rayToken = token('echo-show', ['care.read.user'])
const hostToken = token('alexa-host', ['care.read.user', 'care.read.assistant'])
const writeKey = process.env.UNSAY_WRITE_SECRET ?? DEV_WRITE_SECRET

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

console.log(`
unsay · listening on ${srv.baseUrl}

  ${srv.atRest}
  resource        ${srv.resourceUrl}
  metadata        ${srv.baseUrl}/.well-known/oauth-protected-resource
  verify (public) ${srv.baseUrl}/verify

open these:

  landing         ${srv.baseUrl}/index.html
  Ray's Echo Show ${srv.baseUrl}/echo.html?${q({ token: rayToken })}
  clinician       ${srv.baseUrl}/clinician.html?${q({ token: hostToken, key: writeKey })}

The Echo Show link carries care.read.user ONLY — it cannot read a care-internal://
record even if it asks, and /verify without a token will not admit those chains exist.
The clinician link additionally carries the write key; treat it as a secret.
${process.env.UNSAY_TOKEN_SECRET ? '' : '\nunsay: UNSAY_TOKEN_SECRET unset — tokens above are signed with the dev secret.'}
Ctrl-C to stop.`)

// Repeated on stderr, where a process supervisor will actually keep it.
if (writeKey === DEV_WRITE_SECRET) {
  console.error('unsay: UNSAY_WRITE_SECRET unset — the write path accepts the dev signing key.')
}

let closing = false
const shutdown = async (signal: string) => {
  if (closing) return
  closing = true
  console.error(`\nunsay: ${signal} — closing sessions and the listener.`)
  await srv.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
