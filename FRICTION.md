# Friction log — Unsay

Every entry written **the day it was hit**, not assembled before submission.
Format per entry: task attempted · steps taken · expected vs actual · severity · workaround ·
actionable suggestion.

Tools covered so far: `@modelcontextprotocol/sdk` (TypeScript), MCP spec 2025-11-25,
Amazon Developer account onboarding.

---

## F-001 · MCP TypeScript SDK · client method name does not match the protocol method

**Date:** 2026-09-02 · **Severity:** Low (30 min) · **Tool:** `@modelcontextprotocol/sdk@1.30.0`

**Task attempted.** Subscribe a client to a resource so it receives `notifications/resources/updated`.

**Steps taken.** Read the 2025-11-25 spec, which names the method `resources/subscribe`. Wrote
`await client.subscribe({ uri })` by analogy with the spec name.

**Expected vs actual.** Expected a `subscribe()` method mirroring the protocol method name.
Got `TypeError: client.subscribe is not a function`. The actual method is **`subscribeResource()`**
(and `unsubscribeResource()`).

**Why it's confusing rather than wrong.** The SDK is internally consistent — `readResource` →
`resources/read`, `listResources` → `resources/list`, so `subscribeResource` → `resources/subscribe`
follows its own verb-noun pattern. But the *spec* is what a developer reads first, and the spec says
`subscribe`. The two vocabularies diverge at exactly the surface that is hardest to discover, because
subscription is the one method with no return value to inspect and no example in the README.

**Workaround.** Grep the `.d.ts`:
`grep -oE '^\s{4}[a-zA-Z]+\(' node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts`

**Actionable suggestion.** Add a one-line subscription example to the TypeScript SDK README — there is
currently none — or export a `subscribe` alias. A single snippet showing
`client.subscribeResource()` + `client.setNotificationHandler(ResourceUpdatedNotificationSchema, …)`
would have saved the lookup entirely.

---

## F-002 · MCP spec 2025-11-25 · `annotations.audience` is advisory, with no enforcement story

**Date:** 2026-09-02 · **Severity:** **High (architectural)** · **Tool:** MCP spec 2025-11-25

**Task attempted.** Use `annotations.audience: ["assistant"]` to hold clinical context that shapes the
model's answer but must **never** be spoken to the patient.

**Expected vs actual.** Expected the spec to state what a client MUST do with `audience`. It defines
the field and its two legal values, and places **no obligation on the client to honour it**. A
compliant client may read an `audience: ["assistant"]` resource and speak it verbatim.

**Why this matters here.** In a healthcare context the difference between "reasoning context" and
"speakable" is a safety boundary, not a presentation hint. `"Fall risk high; family disputes the
discharge plan"` must change the advice and must never reach the patient's ears. **A safety-relevant
annotation a client may ignore is a documentation comment, not a control.**

**Workaround.** Do not rely on the annotation. Unsay splits the graph into two URI schemes
(`care://` and `care-internal://`) behind two OAuth scopes, enforced at the resource server. A client
holding only `care.read.user` receives `-32002` on every internal URI — it is never *sent* the content,
so it cannot leak it. The annotation is retained as a correct-by-convention hint for compliant hosts,
but the enforcement is server-side.

**Actionable suggestion.** Either (a) add normative language — "clients MUST NOT surface content
annotated `audience: ["assistant"]` to end users" — or (b) state explicitly in the spec that `audience`
is a rendering hint with no security properties, so implementers don't mistake it for one. The current
silence invites the second reading of a field that looks like the first. Option (a) would make an
entire class of safety-partitioned MCP servers possible without bespoke authorization.

---

## F-003 · MCP spec 2025-11-25 · no defined client behaviour on `notifications/resources/updated`

**Date:** 2026-09-02 · **Severity:** Medium · **Tool:** MCP spec 2025-11-25

**Task attempted.** Guarantee that a correction written by a clinician reaches the assistant's *speech*
while it is mid-answer.

**Expected vs actual.** Expected the spec to say what a client does on receiving `updated` — re-read,
invalidate, or nothing. It specifies the notification's delivery, not its consequence. A conforming
host may receive the notification and never re-read, in which case the user hears the stale answer to
completion and the correction is invisible.

**Severity reasoning.** This cannot be fixed from the server side. It is the one residual risk in
Unsay's design that no amount of server engineering removes.

**Workaround.** Dual path from commit 1 — native subscription for compliant hosts, plus a
`whats_changed` tool with an `outputSchema`, nudged every turn by the server's `instructions` field.
Both are built and both are exercised in CI, because an unexercised fallback is indistinguishable
from a missing one.

**Actionable suggestion.** A SHOULD-level line — "clients SHOULD re-read a subscribed resource on
`notifications/resources/updated` before using its content in a response" — would be enough. Without
it, "live resources" is a delivery guarantee with no freshness guarantee, and every server author has
to invent the same fallback.

---

## F-004 · Amazon Developer account · payment-verification hold blocks all device tracks

**Date:** 2026-09-01 · **Severity:** **High (blocking, multi-day)** · **Tool:** Amazon account onboarding

**Task attempted.** Register for the Ring Developer Portal to build on the Ring track.

**Steps taken.** Attempted sign-in with an existing Amazon account. Account was under a
payment-verification hold requiring documentary proof of ownership of a card used on a past order.

**Expected vs actual.** Expected developer-console access to be gated on developer identity
verification (which the Ring docs describe: government ID, name matching the Company Profile). Instead
it was gated on **retail** payment verification for an **expired debit card**, with no path visible
from the developer console itself.

**Why the friction is sharper than it looks.** The accepted document types assume a card statement
showing the card number. For an Indonesian **debit** card the bank statement shows the *account*
number, never the card number — so the "preferred" evidence type is structurally impossible to
produce, and the correct route (card photo + alternative statement) is the third option down a list
most users will not read that far into.

**Impact on this hackathon.** Blocks the Ring and Fire TV tracks entirely. Alexa+ is unaffected
because a self-hosted MCP server needs no Amazon credential — which is the only reason this project
was buildable on day 1.

**Actionable suggestion.** When a hold blocks the *developer* console specifically, surface the reason
and the remedy inside the developer console rather than only in retail account settings. And in the
document-type list, mark which options work for **debit** cards — the preferred option silently does
not.

---

## F-005 · MCP spec 2025-11-25 + TS SDK · `annotations` are dropped by `resources/read`

**Date:** 2026-09-04 · **Severity:** **High (design-forcing, ~1 h)** · **Tool:** MCP spec 2025-11-25,
`@modelcontextprotocol/sdk@1.30.0`

**Task attempted.** Deliver a fact's `audience`, `priority` and `lastModified` alongside its content,
so a host reading `care://ray/anticoagulant` receives the instruction and the knowledge that it
expired four days ago in the same response.

**Steps taken.** Attached `annotations` to the object in `ReadResourceResult.contents[]`, exactly as
we already do on `resources/list` entries. Ran a real client against the real server over Streamable
HTTP and printed the keys of what arrived.

**Expected vs actual.**

```
LIST  entry keys   : [ 'name', 'uri', 'description', 'mimeType', 'annotations' ]
LIST  annotations  : {"audience":["user"],"priority":0.9,"lastModified":"2026-10-06T09:14:00.000Z"}
READ  content keys : [ 'uri', 'mimeType', 'text' ]
READ  annotations  : undefined
```

Expected the annotation to arrive on both. It arrives on `list` and is **silently discarded** on
`read`. The cause is in the shipped typings — `TextResourceContentsSchema` and
`BlobResourceContentsSchema` carry `uri`, `mimeType`, `_meta` and the payload, and nothing else:

```
node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts
  ResourceSchema        : { uri, name, description, mimeType, size, annotations?, _meta? }
  TextResourceContents  : { uri, mimeType?, _meta?, text }     ← no annotations
  BlobResourceContents  : { uri, mimeType?, _meta?, blob }     ← no annotations
```

Both are `z.core.$strip`, so the client's schema parse deletes the field without an error, a warning,
or a hint that the server sent something. `Annotations` are defined on `Resource`, `PromptMessage` and
`ContentBlock`, and are simply not part of `ResourceContents`.

**Why it matters more than a missing field usually would.** `annotations.audience` is the field an
implementer reaches for when content must not be spoken (**F-002**). Discovering that it is advisory
is bad. Discovering that on the one method that actually carries content it does not arrive at all is
worse, because the two facts point in opposite directions: `resources/list` teaches you the field
works, and `resources/read` quietly proves it does not. A server author who tests against `list` will
ship believing the annotation is delivered.

**Workaround.** Three, all in this repo. Authorization was already server-side (**F-002**), so
nothing leaked. But `lastModified` was going to carry the staleness signal, and it cannot — so
(a) the age is written into the **text body**, as a `[STALE — last changed 4 days ago by Dr Mensah,
GP; say this age aloud]` header prepended to the value in the `resources/read` handler
(`src/server.ts`); (b) the machine-readable copy moved to `_meta`, which `ResourceContents` *does*
define — `unsay/version`, `unsay/versionHash`, `unsay/prevHash`, `unsay/audience`,
`unsay/lastModified`, `unsay/stale`; (c) the annotation is still emitted on both surfaces, because
a non-SDK host that passes the JSON through will see it, and on `resources/list` it survives even
the SDK. Writing the safety-relevant field into free text is ugly, and it is the only channel that
provably reaches the model.

**Actionable suggestion.** Pick one and say it out loud in the spec:

1. Add `annotations` to `ResourceContents` — it is where the content is, and where a per-version
   `lastModified` naturally belongs, since `Resource` describes a URI while `ResourceContents`
   describes what that URI holds right now; **or**
2. state in the `resources/read` section that annotations are carried on the `Resource`, not on its
   contents, and that a server must repeat anything content-specific through `_meta`.

Either is fine. The current state — a field that exists on the listing, is absent from the read, and
is stripped silently by the reference implementation — is the one outcome that costs every server
author the same hour.

---

## F-006 · MCP TypeScript SDK · the OAuth resource-server helpers are express-shaped and route-scoped

**Date:** 2026-09-04 · **Severity:** **High (architectural, ~50 min)** · **Tool:**
`@modelcontextprotocol/sdk@1.30.0`

**Task attempted.** Serve `/.well-known/oauth-protected-resource`, verify bearer tokens, and enforce
**per-resource** scopes: `care://…` requires `care.read.user`, `care-internal://…` requires
`care.read.assistant`.

**Steps taken.** Read every file under `dist/esm/server/auth/` looking for the resource-server half of
the story, since the MCP server here is a resource server and not an authorization server.

**Expected vs actual — two separate problems.**

**(a) Everything in the authorization surface is express.** `mcpAuthMetadataRouter()` returns an
`express.Router`. `requireBearerAuth()` returns an express `RequestHandler`. `metadataHandler()`
returns an express `RequestHandler`. `bearerAuth.d.ts` goes further and does
`declare module 'express-serve-static-core'` to add `Request.auth`, so merely importing it edits
express's types. Meanwhile `StreamableHTTPServerTransport.handleRequest()` takes a plain
`node:http` request/response and needs no framework at all — this repo's transport plumbing is
fourteen lines of `node:http` in `scripts/e2e.ts`. Adopting the SDK's auth helpers means adopting a
web framework for the sole purpose of getting a `.well-known` route and a header check, in a project
whose dependency budget is one package.

**(b) `requiredScopes` cannot express what MCP servers actually need.** The signature is
`requireBearerAuth({ verifier, requiredScopes, resourceMetadataUrl })` — a flat list checked once,
per route. But MCP multiplexes *every* resource behind a single `POST /mcp`. There is no route to
attach a per-resource scope to. `resources/read` on a speakable fact and `resources/read` on a
never-speakable one are the same HTTP request to the same path, differing only in a JSON-RPC param.
Route-level scope checking can therefore only express "this token may talk to this server at all",
which for a server whose entire point is a safety partition is the wrong granularity by one whole
level.

**Workaround.** Do the authorization inside the protocol handler instead of in middleware: the scope
required is derived from the URI's scheme, and both the scheme-derived and the record-derived scope
are checked in `LiveResourceStore.read()` (`src/store.ts`) before any content is returned. The SDK
does plumb `AuthInfo` through to handlers as `extra.authInfo` (`shared/protocol.d.ts`), which is the
piece that makes this possible — it is just not what the auth helpers are built around.

**Actionable suggestion.** Two concrete asks:

1. **Ship a framework-free resource-server path.** A `getOAuthProtectedResourceMetadata(options)`
   returning the plain metadata *object*, and a `verifyBearer(headers, options)` returning
   `AuthInfo | error`, would let a `node:http` (or Workers, or Lambda) server do this in five lines.
   `getOAuthProtectedResourceMetadataUrl()` is already framework-free and is exactly the right shape;
   the rest is not.
2. **Document, in the authorization section, that route-level `requiredScopes` is a floor and not the
   authorization model**, with the pattern for per-resource checks off `extra.authInfo.scopes`.
   Every MCP server with a non-uniform resource graph will hit this, and right now each one has to
   work out on its own that the middleware cannot do the job.

---

## F-007 · MCP spec 2025-11-25 · pagination cursors have no defined semantics against a changing list

**Date:** 2026-09-04 · **Severity:** Medium (~30 min) · **Tool:** MCP spec 2025-11-25,
`@modelcontextprotocol/sdk@1.30.0`

**Task attempted.** Decide whether `resources/list` here should paginate. This server declares
`resources.listChanged` and fires `notifications/resources/list_changed` whenever a new domain
appears — so its resource list changes *while a client could be paging through it*, which is
precisely the case pagination semantics have to pin down.

**Steps taken.** Read the spec's pagination section and the SDK's typings, then tested what a
non-cooperating cursor actually does against a live client.

**Expected vs actual.** The spec defines `cursor` as an opaque token and `nextCursor` as the
continuation, and stops. Three questions it does not answer:

1. **Does `list_changed` invalidate an outstanding cursor?** Unspecified. A client mid-page has no way
   to know whether to restart or continue, and a server has no defined way to tell it.
2. **What must a server return for a cursor it does not recognise or that has expired?** Unspecified.
   No error code is named — not `-32602`, not anything.
3. **Is a server obliged to honour a cursor at all?**

Question 3 is the sharp one, because the answer is observably *no*, and nothing catches it.
Measured against this server on the day it still ignored `params.cursor` (it paginates now — see
the workaround):

```
BOGUS CURSOR : accepted, returned 6 resources
```

A garbage cursor produced a complete, successful, schema-valid response. The SDK validates that a
cursor is a *string* (`CursorSchema = z.string()`) and does nothing else with it, and there is no
auto-pagination helper on the client — `client.listResources(params)` is one round trip, so following
`nextCursor` is the caller's job in every client ever written against this SDK.

**Why it matters.** A server that silently ignores cursors is indistinguishable, to a conforming
client, from one that implements them correctly, until the list outgrows one page. That is a bug that
ships.

**Workaround.** Implement the missing semantics ourselves and write down the choices, since the
spec makes none of them for us. `resources/list` in `src/server.ts` pages a URI-sorted list at
`RESOURCE_PAGE_SIZE = 3`; the cursor carries the **last URI emitted**, not an offset, so a
concurrent publish between two pages cannot silently drop a resource into the gap the way an offset
would; and `decodeCursor()` answers a cursor it did not issue with `-32602` (`ErrorCode.InvalidParams`)
rather than resetting to page one, which would loop a client forever. Three defensible decisions
that every other MCP server author will also have to make, differently.

**Actionable suggestion.** Three lines in the pagination section would close all of it: name the error
for an unrecognised cursor (`-32602` with a defined message), state whether a cursor survives
`notifications/*/list_changed` (a SHOULD either way is better than silence), and state that a server
that receives a `cursor` it did not issue MUST fail rather than return page one. Optionally, an
`iterateResources()` async-generator on the SDK client would stop every consumer re-implementing the
same loop.

---

## F-008 · MCP spec 2025-11-25 · `blob` contents have no size bound anywhere in the stack

**Date:** 2026-09-04 · **Severity:** Medium (~45 min) · **Tool:** MCP spec 2025-11-25,
`@modelcontextprotocol/sdk@1.30.0`

**Task attempted.** Serve a physio's demonstration clip as a `blob` resource, on the same URI scheme
as the text so the audience partition covers the audio too — and size it so that reading it cannot
break the product's one hard claim, that a correction lands inside a ~3.4 s speech window.

**Steps taken.** Looked for a size limit, a guidance figure, or a chunking mechanism in the spec, in
`types.d.ts`, and in both Streamable HTTP transports. Then measured, with a real client over a real
transport, escalating blob sizes:

```
  0.06 MiB raw ->   0.08 MiB base64  read      5 ms
  0.50 MiB raw ->   0.67 MiB base64  read      8 ms
  2.00 MiB raw ->   2.67 MiB base64  read     20 ms
  8.00 MiB raw ->  10.67 MiB base64  read     70 ms
 32.00 MiB raw ->  42.67 MiB base64  read    272 ms
```

**Expected vs actual.** Expected a documented ceiling, or at least a "keep blobs under N MB, use a
URI for anything larger" note. Found none:

- `BlobResourceContentsSchema.blob` is `z.ZodString`. No `.max()`. Base64 with no bound.
- `Resource.size` is `z.ZodOptional<z.ZodNumber>` with no documented unit — raw bytes or base64
  bytes? It matters by a factor of 1.333, and nothing says.
- Neither `server/streamableHttp.js` nor `client/streamableHttp.js` enforces a message-size limit.
- There is no chunking, no range request, and no streaming form of `resources/read`. A blob is one
  JSON-RPC response, buffered whole at both ends.

A 32 MiB clip was therefore accepted end to end, at every layer, without a warning. On loopback that
is 272 ms. Over a typical home connection the same read is 42.67 MiB of base64 — at 5 Mbps, **about
68 seconds**, twenty times the window this product's central claim depends on. (That figure is
arithmetic from the measured payload size, not a measurement over a real link — but the payload size
is real, and no layer in the stack objected to it.)

**Why it matters.** A voice assistant is a latency-bound consumer. `blob` is the one MCP content type
whose size is unbounded by construction, and the same protocol carries the notification that has to
arrive mid-sentence. Every implementer has to independently guess a budget the spec could simply
state.

**Workaround.** Bound it ourselves: the clips in `src/blobs.ts` are 12 kB and 24 kB of WAV, loaded
from committed fixtures under `fixtures/`, cached as base64 on first read, and reported through
`Resource.size` on `resources/list` so a host can decide before it asks. A budget we enforce is not
a budget the protocol enforces.

**Actionable suggestion.** (a) Define `Resource.size` as **raw decoded bytes** in one sentence — the
ambiguity is free to remove. (b) Add non-normative guidance to the `resources/read` section: a
recommended maximum inline `blob` size, and a statement that larger content should be referenced by a
fetchable URI rather than inlined. (c) Let a transport advertise a maximum message size at
`initialize`, so a server can choose a representation instead of discovering the limit as a timeout.

---

## F-009 · TS SDK + Node 22 native type-stripping · no-build-step and type-checked are mutually exclusive

**Date:** 2026-09-04 · **Severity:** Medium (~25 min) · **Tool:** Node 22.22, TypeScript 5.7,
`@modelcontextprotocol/sdk@1.30.0`

**Task attempted.** Run the server with `node --experimental-strip-types` — no bundler, no build
directory, no compile step between the source a judge reads and the process that runs — while still
type-checking against the SDK's shipped `.d.ts`.

**Steps taken.** Node's type-stripping requires relative imports to carry the real extension, so every
import in `src/` is `./store.ts`, `./types.ts`. Then ran `tsc --noEmit` over the same files.

**Expected vs actual.**

```
src/server.ts(23,68): error TS5097: An import path can only end with a '.ts' extension
                      when 'allowImportingTsExtensions' is enabled.
src/server.ts(24,27): error TS5097: ...
src/store.ts(20,8):   error TS5097: ...
```

The extension Node **requires** is the extension `tsc` **rejects** by default. Getting both needs a
`tsconfig.json` with `allowImportingTsExtensions` (which itself requires `noEmit` or
`emitDeclarationOnly`) and, for anything that later does emit, `rewriteRelativeImportExtensions`.
Neither Node's docs nor the SDK's README mentions any of this; the SDK README (172 lines) has no
Node-native-TypeScript section at all. Note also that `--experimental-strip-types` performs **zero**
type checking — it erases annotations and runs. So the default state of a no-build-step project is
that the SDK's typings are decoration and every mismatch surfaces at runtime.

**A concrete cost, not a hypothetical one.** `ReadResourceResult.contents` is a union of text and blob
contents, and the SDK exports **no type guard** to narrow it — `grep 'export declare function is[A-Z]'`
across the typings returns exactly one unrelated helper, `isJsonContentType`. So every consumer writes
`(result.contents[0] as { text: string }).text`, which this repo does in `scripts/e2e.ts` and
`scripts/probe_subscribe.ts`. Under type-stripping that cast is checked by nobody at all: a server
that started returning a blob there would produce `undefined`, not an error.

**Workaround.** Keep `.ts` extensions (Node is the runtime and wins), and treat `tsc` as an opt-in
lint that needs its own config rather than as a gate. The real safety net here is
`scripts/verify.ts` and `scripts/fresh_clone_check.sh`, which assert behaviour rather than types.

**Actionable suggestion.** (a) Export `isTextResourceContents()` / `isBlobResourceContents()` type
guards from the SDK — three lines, and they remove an unchecked cast from every client ever written.
(b) Add a short "Running with Node's native TypeScript support" section to the SDK README with the
exact `tsconfig.json` (`allowImportingTsExtensions`, `noEmit`, `erasableSyntaxOnly`) that makes
`.ts`-extension imports type-check. Node 22 shipping type-stripping by default makes this the fastest
path from `npm install` to a running MCP server, and it is currently undocumented in the one place a
new server author is already reading.

---

## F-010 · MCP TypeScript SDK · the standalone SSE stream sends no priming event, so a fresh stream cannot resume

**Date:** 2026-09-04 · **Severity:** High (3 h) · **Tool:** `@modelcontextprotocol/sdk@1.30.0`

**Task attempted.** Prove that a correction survives the network dropping under an Echo Show:
subscribe, drop the SSE stream as a proxy timeout would, write a revision into the dark, reconnect
with `Last-Event-ID`, and assert the missed `notifications/resources/updated` is replayed.

**Steps taken.** Configured `StreamableHTTPServerTransport` with an `EventStore`, opened the
standalone `GET /mcp` stream from a real client, dropped it server-side, wrote, and waited for the
reconnect.

**Expected vs actual.** Expected the reconnect to carry `Last-Event-ID` and the missed notification
to be replayed. Got a reconnect with **no** `Last-Event-ID` header and the notification silently
lost. The cause is in the SDK: `writePrimingEvent` is called only on the POST response stream
(`dist/esm/server/webStandardStreamableHttp.js:652`), never on the standalone GET stream. A client
that has received nothing on that stream therefore holds no event id, and the transport has nothing
to resume from — so resumability protects only a stream that has already delivered at least one
event, which is precisely not the case when a correction is the first thing to happen.

**Why this matters more than it looks.** The failure is silent and it inverts the guarantee. You
configure an event store, you see it fill, you assume corrections are durable — and the one window
where a household wifi blip actually loses a message is the window before the first event, which is
most of the time on a freshly opened screen.

**Workaround.** `scripts/probe_resume.ts` writes a live revision FIRST, so the client is holding an
event id before the stream is dropped. The probe says so in a comment, because the workaround is
also the disclosure: a correction published before the very first event on a fresh stream is stored
and not replayable.

**Actionable suggestion.** Call `writePrimingEvent` when the standalone GET stream opens, exactly as
the POST stream does — it is a one-line change and it makes `Last-Event-ID` mean what its
documentation implies. Failing that, say in the Streamable HTTP section of the README that
resumability begins at the first delivered event, so an implementer knows the gap exists.

---

## F-011 · MCP TypeScript SDK · Streamable HTTP emits an empty `data:` frame that no document mentions

**Date:** 2026-09-04 · **Severity:** Medium (1 h) · **Tool:** `@modelcontextprotocol/sdk@1.30.0`

**Task attempted.** Write a browser MCP host by hand — `fetch` plus an SSE reader — because the
three pages in `web/` load no script from anywhere and cannot import the SDK.

**Steps taken.** Implemented the obvious SSE reader: split on a blank line, take the `data:` line of
each block, `JSON.parse` it.

**Expected vs actual.** Expected every `data:` line to carry a JSON-RPC message. Got
`SyntaxError: Unexpected end of JSON input` on the very first frame the stream ever delivered: the
transport writes an empty `data:` keep-alive/ack frame before each message. Neither the 2025-11-25
spec's Streamable HTTP section nor the SDK README mentions it, and the failure lands on frame one,
so it reads as "my reader is broken" rather than "there is a frame here I was not told about".

**Workaround.** A proper SSE framer in both pages: normalise CRLF, concatenate multi-line `data:`
fields, skip empty payloads, capture `id:` for resumption. It is thirty lines and every hand-written
client will need the same thirty lines.

**Actionable suggestion.** Either omit the `data:` line when there is no payload — a bare `:` comment
line is the SSE-native keep-alive and every reader already ignores it — or document the ack frame in
the transport section. One sentence prevents a first-frame crash in every non-SDK client.

---

## F-012 · MCP spec 2025-11-25 · `list_changed` has no defined semantics for a server's initial state

**Date:** 2026-09-04 · **Severity:** Medium (2 h) · **Tool:** MCP specification 2025-11-25

**Task attempted.** Declare `resources.listChanged` and send
`notifications/resources/list_changed` when the GP adds a new care domain — without telling a host
that the care plan changed merely because the server finished starting up.

**Steps taken.** Read the specification's `list_changed` section for guidance on a server whose
resource list is populated at boot. There is none: the notification is defined, its initial-state
semantics are not.

**Expected vs actual.** Expected a rule such as "do not send `list_changed` for resources present
before the client's first `resources/list`". Found nothing, so every implementation invents its own
suppression window. Ours was a `queueMicrotask` flag — and it turned out to be **untestable**: a
notification sent before any transport is attached fails silently, so a correctly suppressed
notification and a wrongly sent one produce identical observable behaviour. The test we wrote to
prove the guard worked would have passed with the guard deleted.

**Workaround.** Arm on the first `resources/list` actually served over the connection. The rule is
the notification's own meaning — `list_changed` invalidates a list, and a client that has never
listed holds none — and unlike the microtask flag it is testable: `test/server.test.ts` now seeds the
store with the host already connected and asserts zero notifications for eight seeded domains, then
exactly one when a new domain appears.

**Actionable suggestion.** Add one line to the spec: *"Servers SHOULD NOT send
`notifications/resources/list_changed` to a client that has not yet called `resources/list`."* It
makes the suppression window uniform across implementations and, more importantly, makes it
observable — which is the difference between a guard and a comment.

---

*Filed to the submission's product-feedback field, and F-002/F-003 additionally to the MCP
specification repository. Send-by date for upstream filing: **2026-09-20** — a draft with no send
date is a loss in progress.*

*F-005 through F-012 were found by building against the spec and the reference SDK, not by reading
about them; each names the file or the measurement it came from. F-005, F-007, F-008 and F-012 are
specification asks, F-006, F-009, F-010 and F-011 are SDK asks, and all carry the same send-by date.*

---

# What this build does NOT do

Friction above is what the tools cost us. This is what **we** did not finish, or finished
in a narrower form than the words might suggest. It is here rather than in a footnote
because a judge who finds one of these on their own has stopped believing the rest.

Each item names where to look, so none of it has to be taken on trust.

### Deployment and AWS

- **Nothing is hosted.** `npm start` runs the server on your machine. There is no URL a
  judge can open without cloning. No Lambda, no API Gateway, no DynamoDB.
- **The KMS path has never run against a live CMK.** `KmsKeyProvider` in `src/envelope.ts`
  builds real SigV4-signed `GenerateDataKey` / `Decrypt` requests over `fetch` with no AWS
  SDK, and the tests assert the canonical request, the signed-header list, the endpoint and
  the `x-amz-target`. What they do not assert is that AWS accepts it, because the account is
  under the payment-verification hold logged as F-004. Read that provider as
  **signed and shaped, not exercised**. The local HKDF provider is complete and is what every
  gate in this repo actually runs.
- The `fetch` injection point on `KmsKeyProvider` is a constructor field used by exactly one
  test. `fromEnv()` never sets it and no environment variable reaches it, so there is no
  runtime path that fakes AWS — but it is a seam and it is named here as one.

### OAuth

- **There is no authorization server.** Unsay is a protected *resource*: no `/authorize`, no
  `/token`, no refresh, no revocation, no dynamic client registration, no consent screen, no
  JWKS. Tokens are HS256 under a shared secret, minted by `mintToken()` in the same file that
  verifies them (`src/http.ts`). The verification is real and is asserted by `npm run verify`
  section 6 — an edited scope claim fails the MAC — but the *deployment shape* is not OAuth.
- **No `jti` replay cache.** A lifted token is spendable until it expires.
- **Symmetric only.** Verifying RS256/ES256 tokens from a real authorization server via JWKS
  is not implemented, so integrating one is a code change, not a config change.
- `authorization_servers` names this origin by default, because in the default configuration
  this codebase is literally what issues the tokens. `UNSAY_AUTH_SERVER` overrides it. We
  deliberately do not advertise an `/authorize` endpoint we do not serve.

### The write path

- **One shared write secret.** The HMAC proves that *a* holder of the write secret wrote
  this, not *which* clinician. `authorId` is claimed in the body and made immutable by the
  hash chain — that is immutability, not authenticity.
- **Replay protection is the 300 s skew window and nothing else.** There is no nonce cache,
  so a captured request can be re-sent inside its own window. Stated rather than hidden.
- **`DEV_` secrets are used when the environment variables are unset**, and the server says so
  on stderr at every start.

### Durability

- The store, the `MemoryEventStore` behind resumability, and the audit log are **in memory**.
  Restarting loses replay history. The audit log survives only if `UNSAY_AUDIT_LOG` names a
  file. "At rest" therefore means the store's own byte representation, not a database on disk.
- One data key per process (standard data-key caching). Rotation is supported on read through
  `Envelope.openAsync()`, which unwraps whatever key the stored bytes name, but there is no
  automatic re-seal of existing records after a rotation.
- The envelope header (format version, provider, key id, wrapped-key length) is deliberately
  **outside** the AAD so a receipt can name the provider and key of stored bytes without
  holding the key. The consequence: editing the header is detectable as a decryption failure,
  not as a distinct "header tampered" error.

### Resumability

- See F-010. A correction published before the very first event on a fresh stream is stored
  and **not** replayable. `scripts/probe_resume.ts` writes a live revision first for exactly
  this reason and says so in a comment.
- `dropStreams()` closes the SSE stream server-side, which is what a proxy or an idle timeout
  does. It is a real disconnect the client reconnects from; it is not simulated packet loss.

### The audience partition

- **T-7, the confused deputy, is the residual risk of the whole design and is not mitigated.**
  A reasoning host legitimately holds both scopes. The partition protects Ray against a
  user-scoped client; it does not protect him against the reasoning host choosing to speak.
  `scripts/e2e.ts` grants its host principal both scopes, and a judge who opens that file
  should find this paragraph already waiting. Only `prompts/get` narrows the principal.
- **Session-to-principal binding is by `sub`.** Another subject's session id is refused with
  403. Two tokens for the *same* `sub` with different scopes used on one session resolve to
  whichever token the current request carried, with the last-seen principal as the fallback
  for out-of-request notifications — a fallback only reachable by requests that already passed
  token verification.
- **`GET /verify` without a token lists only `care://` chains.** That is deliberate: a public
  endpoint enumerating `care-internal://` URIs would undo the partition on an open port. The
  cost is that an anonymous judge sees the hash chain proved for the speakable half only, and
  has to present a `care.read.assistant` token for the rest.
- `logRevision()` resolves the principal outside any request context. If a deployment makes
  that resolution request-scoped and it throws from a store listener, the revision is silently
  not logged. Deliberate — we will not name a URI to a listener we cannot identify — but it
  means the logging channel can go quiet under a principal implementation we do not control.
  `notifications/resources/updated` is unaffected.

### CORS and transport

- `Access-Control-Allow-Origin` echoes the request origin. That is safe **because** every
  authenticated route requires a Bearer token or a body HMAC and there is no cookie and no
  ambient authority for an origin to borrow — but it is permissive, and it is a decision, not
  an oversight.
- **Every test and every gate runs over plain HTTP on 127.0.0.1.** Nothing in this repo
  exercises TLS or certificate handling. Bearer tokens over plain HTTP are acceptable only
  because the bind address is loopback.

### The demo surfaces

- **The landing-page hero is an illustration, not a recording.** It is labelled twice on the
  page and a test asserts both labels are present. The wording is the scripted retraction and
  the values are the committed seed record, but the timing on screen is scripted. The live run
  is `npm run e2e`.
- **The two WAV fixtures are synthesized, not recorded.** They are valid, playable 4 kHz PCM
  WAVs regenerated byte-identically by `npm run fixtures`, and their signal content is honest —
  the pacer really does pace ten heel slides, the gait trace really does encode an asymmetric
  step interval. But no physio recorded them and no patient was walking, and nobody should
  describe them on camera as a clinician's recording.
- **With no server answering, the pages fall back to the committed seed values** and say
  `SEED · NOT LIVE` on the device screen itself, where presentation mode cannot hide it. No
  correction, strike-through or latency figure can appear in that state.
- The clinician receipt's "a subscribed host was corrected in N ms" is measured over the
  page's *own* MCP subscription. That subscribed host is the browser tab, not an Echo Show.
  The wording says "a subscribed host" for that reason.
- The `subscribers` count `POST /write` returns is a count of **server-side sessions** holding
  a subscription to that URI. A host that disappears without sending `DELETE /mcp` keeps its
  session, and therefore its subscription, until the session is closed — so the count can be
  one higher than the number of screens actually watching. It is a real count of real
  subscriptions, which is strictly better than the constant `true` it replaced, but it is not
  a liveness check.
- The p50/p95 on the landing page live **inside** the page, because `file://` cannot fetch a
  sibling file. They are written there by `npm run bench` itself, rounded up to one decimal, so
  the page and the receipt come out of the same run and `web/web.test.ts` asserts they match
  exactly. An earlier version transcribed them by hand with a tolerance band, and the band turned
  out to be measuring run-to-run variance rather than staleness — it went red on an honest re-run.
- Each page carries its own copy of the ~40-line MCP-over-`fetch` client and the SSE framer.
  The single-file-per-page constraint requires it; a fourth surface should become a shared
  `web/mcp.js` instead.
- The pages were validated by structure parse, `node --check` on every page script, and a Node
  replay of their own request sequence and SSE parser against a live server. **Rendering,
  animation timing and the 1280×800 device fit are not visually verified.**

### The number

- `npm run bench` measures **loopback** Streamable HTTP: signed write → HMAC verification →
  store → notification → authorized re-read, all on 127.0.0.1. A deployed path adds network
  and infrastructure and this figure is never quoted as a production number.
- The 3,400 ms "speech window" every latency claim is measured against is an **assumption** —
  twelve words at roughly 150 wpm, a constant in `scripts/bench.ts`. It is not a measurement of
  Alexa+ text-to-speech.

### Not started

No demo video. No published npm package. No external users. No deployment URL. None of these
is claimed anywhere else in this repository, and this line exists so that absence is explicit
rather than merely unmentioned.
