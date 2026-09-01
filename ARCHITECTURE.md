# Architecture

> **Generated from the codebase** by `scripts/gen_architecture.ts` — run `npm run docs:arch`.
> Nothing here is hand-written. If a surface is listed, a handler for it exists in `src/`.
> LESSONS R6: eight prior submissions documented routes that were never built.

_Generated: 2026-09-01T21:33:30.761Z_

## MCP surfaces actually registered

| Protocol method | Registered in |
|---|---|
| `tools/call` | `src/server.ts` |
| `completion/complete` | `src/server.ts` |
| `resources/templates/list` | `src/server.ts` |
| `resources/list` | `src/server.ts` |
| `tools/list` | `src/server.ts` |
| `resources/read` | `src/server.ts` |
| `resources/subscribe` | `src/server.ts` |
| `resources/unsubscribe` | `src/server.ts` |
| `notifications/resources/list_changed` | `src/server.ts` |
| `notifications/resources/updated` | `src/server.ts` |

**8 request handlers + 2 notification sender(s).**

## Declared capabilities

```js
resources: { subscribe: true, listChanged: true },
        completions: {},
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
```

## Modules

| File | Exports |
|---|---|
| `src/seed.ts` | `RAY`, `DEMO_NOW`, `seed`, `STAGED_REVISION` |
| `src/server.ts` | `SERVER_INSTRUCTIONS`, `buildServer` |
| `src/store.ts` | `NotFoundError`, `hashVersion`, `uriFor`, `LiveResourceStore`, `parseUri` |
| `src/types.ts` | `SCHEME`, `SCOPE` |

## Executable scripts

| Command | File |
|---|---|
| `npm run probe` | `scripts/probe_subscribe.ts` |
| `npm run test` | `test/**` |
| `npm run verify` | `scripts/verify.ts` |
| `npm run e2e` | `scripts/e2e.ts` |
| `npm run bench` | `scripts/bench.ts` |
| `npm run docs:arch` | `scripts/gen_architecture.ts` |

## Runtime dependencies

| Package | Version | Used in |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.30.0` | `src/server.ts`, `scripts/bench.ts`, `scripts/e2e.ts`, `scripts/probe_subscribe.ts` |

## Not built

Stated so this document cannot imply otherwise:

- No AWS deployment yet — DynamoDB/Lambda/KMS are in the plan (`../specs/architecture.md`), not in this repo.
- No HTTP entrypoint deployed; the server is exercised over Streamable HTTP by `scripts/e2e.ts` and `scripts/bench.ts`.
- No ML model of any kind, by design — the reasoning model belongs to the host.
- No blockchain, token, or payment surface.
