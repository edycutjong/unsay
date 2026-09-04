# Architecture

> **Generated from the codebase** by `scripts/gen_architecture.ts` — run `npm run docs:arch`.
> Nothing here is hand-written. If a surface is listed, a handler for it exists in `src/`.
> LESSONS R6: eight prior submissions documented routes that were never built.

_Generated: 2026-09-04T09:23:54.550Z_

## MCP surfaces actually registered

| Protocol method | Registered in |
|---|---|
| `tools/call` | `src/server.ts` |
| `completion/complete` | `src/server.ts` |
| `prompts/get` | `src/server.ts` |
| `prompts/list` | `src/server.ts` |
| `resources/templates/list` | `src/server.ts` |
| `resources/list` | `src/server.ts` |
| `tools/list` | `src/server.ts` |
| `resources/read` | `src/server.ts` |
| `resources/subscribe` | `src/server.ts` |
| `resources/unsubscribe` | `src/server.ts` |
| `notifications/message` | `src/server.ts` |
| `notifications/resources/list_changed` | `src/server.ts` |
| `notifications/resources/updated` | `src/server.ts` |

**10 request handlers + 3 notification sender(s).**

Declaring `logging` also makes the SDK serve `logging/setLevel` without a handler of
our own, so it is a surface a host can call but is deliberately not listed above —
this table only names methods with a handler in `src/`.

## HTTP routes

| Route | Methods | Auth |
|---|---|---|
| `/.well-known/oauth-protected-resource` | GET | public (RFC 9728) |
| `/.well-known/oauth-protected-resource/mcp` | GET | public (RFC 9728) |
| `/health` | GET | public |
| `/mcp` | POST · GET · DELETE | Bearer (care.read.user / care.read.assistant) |
| `/verify` | GET | public — a token widens what it lists |
| `/write` | POST | HMAC-SHA256 over the raw body, or Bearer care.write |
| `/index.html` (and `/`) | GET · HEAD | public — served from `web/` |
| `/clinician.html` | GET · HEAD | public — served from `web/` |
| `/echo.html` | GET · HEAD | public — served from `web/` |

**6 routes + 3 static pages**, all in `src/http.ts`.

## Declared capabilities

```js
resources: { subscribe: true, listChanged: true },
completions: {},
prompts: {},
// A second, cheap notification channel. Declaring it also makes the SDK
// serve logging/setLevel, so a host can turn the revision log down.
logging: {},
tools: {},
```

## Modules

| File | Exports |
|---|---|
| `src/audit.ts` | `AuditLog` |
| `src/blobs.ts` | `EXERCISE_CLIP`, `GAIT_NOTE`, `CLIPS`, `blobFor` |
| `src/envelope.ts` | `EnvelopeError`, `MasterKeyMissingError`, `KmsUnavailableError`, `DecryptionFailedError`, `EnvelopeKeyMismatchError`, `recordAad`, `describeSealed`, `Envelope`, `startupLine`, `announceOnce`, `LocalKeyProvider`, `KmsKeyProvider`, `envelopeFromEnv` |
| `src/http.ts` | `DEV_TOKEN_SECRET`, `DEV_WRITE_SECRET`, `SCOPES_SUPPORTED`, `WRITE_SKEW_MS`, `mintToken`, `TokenError`, `verifyToken`, `writeSigningMaterial`, `signWriteBody`, `MemoryEventStore`, `createHttpServer` |
| `src/seed.ts` | `RAY`, `DEMO_NOW`, `seed`, `seedDemo`, `STAGED_REVISION` |
| `src/server.ts` | `SERVER_INSTRUCTIONS`, `RESOURCE_PAGE_SIZE`, `BRIEF_CARER`, `buildServer` |
| `src/store.ts` | `NotFoundError`, `hashVersion`, `uriFor`, `LiveResourceStore`, `parseUri` |
| `src/types.ts` | `SCHEME`, `SCOPE` |

## Executable scripts

| Command | File |
|---|---|
| `npm run start` | `scripts/serve.ts` |
| `npm run probe` | `scripts/probe_subscribe.ts` |
| `npm run probe:resume` | `scripts/probe_resume.ts` |
| `npm run test` | `test/**` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | `scripts/verify.ts` |
| `npm run e2e` | `scripts/e2e.ts` |
| `npm run bench` | `scripts/bench.ts` |
| `npm run seed` | `scripts/seed_dump.ts` |
| `npm run fixtures` | `node --experimental-strip-types fixtures/gen.ts` |
| `npm run keygen` | `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` |
| `npm run docs:arch` | `scripts/gen_architecture.ts` |

## Runtime dependencies

| Package | Version | Used in |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.30.0` | `src/http.ts`, `src/server.ts`, `scripts/bench.ts`, `scripts/e2e.ts`, `scripts/probe_resume.ts`, `scripts/probe_subscribe.ts`, `scripts/verify.ts` |

## Not built

Stated so this document cannot imply otherwise:

- **No AWS deployment.** `npm start` runs the server locally and nothing is hosted. The KMS
  provider in `src/envelope.ts` is SigV4-signed and shaped correctly but has never been
  executed against a live CMK — see FRICTION.md F-010.
- **No authorization server.** Unsay is an OAuth 2.1 protected RESOURCE only: no `/authorize`,
  no `/token`, no refresh, no revocation, no JWKS. Tokens are HS256 under a shared secret,
  minted by `mintToken()` in the same file that verifies them.
- **No durable storage.** The store, the event store and the audit log are in memory; the
  audit log survives only if `UNSAY_AUDIT_LOG` names a file.
- No ML model of any kind, by design — the reasoning model belongs to the host.
- No blockchain, token, or payment surface.
