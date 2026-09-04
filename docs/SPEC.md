# SPEC — invariants and threat model

What Unsay guarantees, where each guarantee is enforced, and what asserts it.

Every claim below was checked against the source before it was written. References are
`file › function` rather than `file:line`, because line numbers drift and a stale line number is
a lie with a plausible shape. If a claim here is not greppable in the file it names, it is a bug
in this document — file it.

References span **two** trees, and that is the one thing this document got wrong for a day: the
generic mechanism — the store, the chain, the partition, the notifier — was lifted into
`packages/live-resources/` on day 7, and every `src/store.ts › …` reference here went on naming a
file that had become a 116-line adapter. `src/` is now the care-specific half (`server.ts`,
`http.ts`, `seed.ts`, `envelope.ts`, `retraction.ts`); `packages/live-resources/src/` is the half
that knows nothing about hips. Both are named explicitly below.

Two things this document does deliberately, because eight prior submissions in this builder's
history lost points for documenting behaviour that was never built:

- it names, in [Coverage gaps](#coverage-gaps), every place where an invariant is implemented and
  something about it is still unasserted — including the two that are proven by a script rather
  than by `npm test`;
- it has a [what we do **not** defend against](#what-unsay-does-not-defend-against) section, and
  a [not built](#not-built) section, and both are longer than a marketing document would allow.

---

## Vocabulary

| Term | Meaning here |
|---|---|
| **principal** | `{ sub, scopes[] }` — who is asking. `src/types.ts › Principal` |
| **speakable** | audience `user`; URI scheme `care://`; scope `care.read.user` |
| **internal** | audience `assistant`; URI scheme `care-internal://`; scope `care.read.assistant` |
| **revision** | a new version appended to a domain's chain; fires `notifications/resources/updated` |
| **the speech window** | 3400 ms — a 12-word utterance at ~150 wpm. An **assumption**, declared as a constant in `scripts/bench.ts`, not a measurement of Alexa+ TTS |

The scheme→audience→scope mapping is two tables, `SCHEME` and `SCOPE`, in `src/types.ts`. They
are the only place that mapping exists; nothing else in the codebase puts a scheme string next
to a scope string.

---

## Invariants

### I-1 · Internal content is unreachable by a user-scoped principal

**Statement.** A principal whose scopes do not include `care.read.assistant` can obtain the
content of an `audience: "assistant"` record — text or blob — through no code path in this repo.

**Why.** `"Fall risk: HIGH. … Family disputes the discharge plan"` (`src/seed.ts`) must shape the
assistant's answer and must never reach Ray's ears. That is a safety boundary, not a rendering
preference, so it cannot depend on the client behaving.

**Where enforced.** `packages/live-resources/src/store.ts › read()` — two checks, deliberately redundant:

1. the scope required by the **URI's scheme**, via `SCOPE[parsed.audience]`;
2. the scope required by the **record's own** audience, after lookup.

Check 2 exists because check 1 trusts the URI the caller supplied: a caller asking for an
internal record under a `care://` URI passes check 1 and fails check 2.

Check 1 earns its place in the mirror case, and it is not decorative. Chains are keyed by
subject and topic, *not* by audience, so `care://ray/risk` resolves to the same record as
`care-internal://ray/risk`. A principal holding `care.read.assistant` and **not**
`care.read.user` passes check 2 — it may read that record — and check 1 is the only thing that
stops the internal value being served under a scheme a host is entitled to speak. Removing it
used to leave the whole suite, `npm run verify` and `npm run e2e` green; the test named below
is the one that fails now.

Everything funnels through `read()`. `staleness()` calls it. `src/server.ts` calls it for
`resources/read` and again in the `resources/subscribe` handler before recording a subscription.
Blobs ride the same path by construction: `src/blobs.ts` is a byte registry keyed by URI that
carries **no authorization logic at all**, and `blobFor(uri)` is only ever reached after
`store.read()` has already returned — so the partition covers audio without a second,
drift-prone check. `src/http.ts › handleVerify()` is public and therefore defaults its principal
to `{ scopes: [SCOPE.user] }`, so the open port lists speakable chains only.

**Asserted by.** `test/store.test.ts` — *"hides assistant-only records from a user-scoped
principal"*, *"will not let a care:// uri reach an assistant-only record"*, and *"serves
assistant-only records to a principal holding the scope"* (the partition must be a partition, not
a wall). `test/envelope.test.ts` — *"still hides assistant-only records from a user-scoped
principal"*, i.e. encryption did not quietly change the answer, and — pinning check 1
independently of check 2 — *"refuses a care:// uri for an internal record even to a principal
that could read it internally"*. `scripts/verify.ts` §1 exits non-zero if either internal domain
is readable with `care.read.user`.

---

### I-2 · The *existence* of internal content is not leaked either

**Statement.** For a user-scoped principal, a forbidden URI and a nonexistent URI are
indistinguishable in error code and in message shape.

**Why.** `403` on `care-internal://ray/risk` and `404` on `care-internal://ray/nonsense` together
are an oracle: a patient-facing token could enumerate which clinical concerns exist for a patient
without ever reading one. The list of a patient's problems is itself the disclosure.

**Where enforced.** `packages/live-resources/src/errors.ts › NotFoundError` — JSON-RPC `-32002`,
message `Resource not found: ${uri}`, raised identically for a wrong scope, an unparseable URI, an
absent chain, and an absent version. `packages/live-resources/src/store.ts › list()` filters by
scope before building the array,
so an unauthorized URI is never enumerated — which also means it can never appear in a
pagination page or a cursor.

The same rule is applied to **both** notification channels and to the **replay** of either,
which is the easy place to forget it. `src/server.ts › logRevision()` re-parses the URI and
returns early unless the principal holds the scope for that audience, before anything reaches
`notifications/message`. The `updated` channel does the same at SEND time through the notifier's
`canNotify` guard (`packages/live-resources/src/notifier.ts`), so a subscription authorized under
a wider scope stops delivering the moment the session's principal narrows.

Guarding the live path alone was not enough, and for a while that is all this build did. A frame
is *stored* when it is sent, and `Last-Event-ID` hands it back later: a session that resumed under
a narrowed token of the same subject was replayed `care-internal://ray/risk`, its version, its
author, its timestamp and both hash-chain links, straight past both guards. `src/http.ts ›
MemoryEventStore.replayEventsAfter()` now re-authorizes every stored frame against the resuming
principal — `replayAllowed()` reads the URI out of `params.uri`, `params.data.uri`,
`result.contents[].uri` and `result.resources[].uri`, and fails closed on a URI this partition did
not issue. Announcing *"care-internal://ray/risk changed"* on either channel, live or replayed,
would confirm exactly what `read()` refuses to confirm on a third.

**Asserted by.** `test/store.test.ts` — *"reports NotFound rather than Forbidden, so existence is
not confirmed"* substitutes the domain name out of both messages and requires them to be equal;
*"omits assistant-only URIs from list() for a user-scoped principal"*. `test/http.test.ts` —
*"withholds an internal URI from a resume whose principal has narrowed"* drives the whole leak over
real sockets (subscribe wide, drop the stream, resume narrow) and asserts the wide resume still
replays, so the guard is shown to drop frames on scope rather than because replay is broken;
*"reads the URI out of every frame shape that carries one"* and *"fails closed on a URI this
partition did not issue"* pin the predicate itself. `scripts/verify.ts` §2.

**Residual.** Timing. `read()` does more work for a record that exists than for one that does
not, and nothing here constant-times that path. For an in-process `Map` the difference is
sub-microsecond and swamped by transport jitter, but it is not zero and we do not claim it is.

---

### I-3 · A fact's audience can never be changed by a later write

**Statement.** Once a domain's v1 is published with an audience, every later version of that
domain has the same audience, or the write is refused.

**Why.** Without this the partition is a lock with the key taped to it: republish `risk` as
`audience: "user"` and content that was unspeakable a second ago sits on a `care://` URI every
patient-facing token can read. The boundary has to be a property of the fact, not of the most
recent write to it.

**Where enforced.** `packages/live-resources/src/store.ts › publish()` compares `prev.audience` with `input.audience` and
throws **before** any state is mutated — a refused write leaves no partial version behind. The
HTTP write path does not re-implement the rule; `src/http.ts › handleWrite()` lets `publish()`
throw, answers `409`, and appends an audit row with reason `store_rejected`.

**Asserted by.** `test/store.test.ts` — *"refuses to change a record audience on a later write"*.
`scripts/verify.ts` §5.

---

### I-4 · `annotations.audience` is never the control

**Statement.** No authorization decision in this codebase reads an annotation. The control is the
URI scheme bound to an OAuth scope, decided server-side from the stored record.

**Why.** Two independent reasons; either alone is sufficient.

1. **The spec makes it advisory.** MCP 2025-11-25 defines `annotations.audience` and its two
   legal values and places no obligation on a client to honour it. A compliant client may read an
   `audience: ["assistant"]` resource and speak it verbatim. `FRICTION.md` **F-002**.
2. **On a read it does not even arrive.** `ReadResourceResult.contents` is a union of
   `TextResourceContents` and `BlobResourceContents`, and neither schema has an `annotations`
   field — unknown keys are stripped. A server that attaches annotations to a read result watches
   the client parse them away. Measured against a live client, not assumed. `FRICTION.md`
   **F-005**.

So the annotation is emitted as a correct-by-convention hint where it survives
(`resources/list`), emitted on reads too for non-SDK hosts that pass JSON through, and is
load-bearing nowhere. The load-bearing copy on a read is `_meta` — `unsay/version`,
`unsay/versionHash`, `unsay/prevHash`, `unsay/audience`, `unsay/lastModified`, `unsay/stale` —
which `ResourceContents` does define and which therefore actually reaches the host.

**Where enforced.** By absence, which is the only way to enforce a negative:
`grep -rn "annotations" src/` returns two call sites in `server.ts` that attach the builder's
output to a list entry and to a read content, the declaration on the `ui://` card
(`src/ui_resource.ts`), a type re-export, and comments. The builder itself,
`packages/live-resources/src/store.ts › annotationsFor()`, is one object literal. **None is a
conditional.** No branch in either tree has an outcome that depends on an annotation.

**Asserted by.** Every I-1 and I-2 assertion, structurally: they exercise `LiveResourceStore`,
where annotations are produced and never consulted, and still fail closed. The grep is the direct
check and is cheap to re-run.

---

### I-5 · A revision is provable, and a tampered version is located exactly

**Statement.** Each version carries `versionHash = SHA-256(prevHash ‖ JSON(value) ‖ writtenAt ‖
authorId)` and `prevHash`. Replaying a chain either returns `intact: true` or names the first
version that disagrees with its recomputation.

**Why.** *"The physio changed this thirty seconds ago"* is a provenance claim an assistant is
about to speak aloud to a patient. A claim a judge cannot recompute is marketing. Binding
`authorId` into the hash means a substituted **author** breaks the chain too, not only a
substituted value — the *who* is as load-bearing as the *what*.

**Where enforced.** `packages/live-resources/src/chain.ts › hashVersion()` and
`packages/live-resources/src/store.ts › verify()`. `publish()`
computes each hash from the previous version's hash, so the chain is built at write time and
never reconstructed from a mutable field.

**The hash covers plaintext, always** — deliberately, and the reason is in the code comment: a
ciphertext carries a random IV, so hashing stored bytes would change on every re-seal and prove
nothing about what the clinician wrote. Hashing plaintext also keeps `verify()` meaningful for an
auditor holding the audit log and no key. Under an envelope, `verify()` opens each version first;
bytes that fail the GCM tag are reported at the same coordinates a hash break would use, so
callers have one failure shape.

**Asserted by.** `test/store.test.ts` — *"detects tampering and locates the version"* (mutate v1
through the `_tamper` seam, then require `intact === false` **and** `brokenAt === 1`), *"chains v2
to v1"*, *"produces a different hash when the author differs"*, *"is deterministic for identical
inputs"*. `test/envelope.test.ts` — *"keeps the version chain intact through encryption"*,
*"hashes the PLAINTEXT, so the chain is identical encrypted or not"*, *"catches a flipped bit in
stored ciphertext at verify time"*. `scripts/verify.ts` §3 corrupts a real seeded chain and fails
if the corruption is not detected. `src/http.ts › handleVerify()` exposes the same replay on a
public route.

**Limit.** A hash chain is *detection*, not *prevention*. Prevention against an attacker who owns
storage is I-6.

---

### I-6 · A ciphertext only opens in the slot it was sealed in

**Statement.** When an envelope is configured, a record's value is sealed with AES-256-GCM under
AAD `patient|domain|v{version}|audience`. Bytes moved to any other record, audience or version
fail to authenticate.

**Why.** I-1 is enforced at *read* time by scope. That holds against a client. It does not hold
against an attacker with **write** access to storage, who can copy `care-internal://ray/risk`'s
bytes into `care://ray/weight_bearing` and have the server read Ray's fall-risk assessment out
loud to him. Binding the record's identity into the AAD closes that: the partition survives an
adversary who owns the database.

**Where enforced.** `src/envelope.ts › recordAad()` builds the AAD and **reserves `|`**, throwing
rather than letting two distinct identities collide on a component containing the separator.
`Envelope.encrypt/decrypt` set it as GCM AAD. `packages/live-resources/src/store.ts › #seal()/#open()`
are the only paths
in or out, and every accessor that hands out a record goes through `#open()`.

Two providers, both real. `LocalKeyProvider` derives data keys with HKDF-SHA256 from
`UNSAY_MASTER_KEY` and is complete with no AWS account. `KmsKeyProvider` makes SigV4-signed
`GenerateDataKey`/`Decrypt` calls to KMS over `fetch` and **refuses rather than degrades** — an
unconfigured KMS provider throws a typed error naming every missing variable, and never silently
falls back to local, because the startup line must not lie about where key material lives. With
no provider configured the store is plaintext and `startupLine()` says the word PLAINTEXT.

**Asserted by.** `test/envelope.test.ts` — *"REFUSES a ciphertext pasted into another record"*,
*"REFUSES the same record under a different audience"*, *"REFUSES a ciphertext replayed onto a
different version of the same record"*, *"DEFEATS a cross-record paste in storage itself"*, plus
flipped-bit tests on ciphertext, tag and IV, truncation, non-envelope bytes, nonce uniqueness,
key isolation across master keys, and the KMS provider's refusal to start unconfigured. The
store-level tests assert that no seeded record — the never-speakable one specifically — is
recoverable from at-rest bytes.

**Limit.** An attacker holding **both** storage and the data key can re-seal anything under the
correct AAD and recompute the chain. AAD binding defeats relocation, not full compromise.

---

### I-7 · A stale fact announces its own age instead of being spoken with confidence

**Statement.** A record past its `staleAfter` is served with its age and its author in the **text
body**, prefixed `[STALE — …; say this age aloud]`, computed server-side.

**Why.** The failure this product exists to prevent is a confident sentence about an expired
fact. Ray's anticoagulant record carries a stop date four days behind whatever clock the seed is
built on, and the sentence names that date in words (`src/seed.ts`); read flat, it instructs a
68-year-old to keep taking a drug he was told to stop. Both halves move together on purpose: the
`staleAfter` was made relative to the injected clock while the sentence stayed pinned to
"4 October 2026", so on every day but one the live server flagged the record as past its review
date while its own words named a stop date still in the future. `scripts/verify.ts` §9 now reads
the sentence, not only the header.

**Why the age is in the body.** By I-4, an annotation does not survive a read, so a design that
put the age only in `annotations.lastModified` would announce nothing. Putting it in the text
means the model cannot receive the fact without receiving its age. `_meta['unsay/stale']` carries
the machine-readable copy alongside.

**Where enforced.** `packages/live-resources/src/store.ts › staleness()` computes age and the
boolean against an injected `now`; `src/server.ts`'s `resources/read` handler builds the header and
prepends it to the value;
the `brief_carer` prompt appends `— PAST ITS REVIEW DATE, say its age aloud` to any stale line.

**Asserted by.** `test/store.test.ts` — *"flags a record past its stale_after"*, *"does not flag a
record with no stale_after"*, *"computes age from writtenAt"*. `scripts/verify.ts` §4 asserts both
directions on seeded data — a checker that flags everything proves nothing. `scripts/e2e.ts`
asserts the delivered text actually `startsWith('[STALE')` after a full round trip over Streamable
HTTP, and exits non-zero if not.

**Clock note.** Staleness is computed from the **server's** clock, never the client's, so a host
with a wrong clock cannot make a stale fact look fresh. The write path is stricter still:
`src/http.ts › handleWrite()` sets `writtenAt` from the server clock and ignores any value in the
body, because a writer who could set it could backdate a correction — and "how old is this
instruction" is a spoken safety claim.

---

### I-8 · A creation is not a change

**Statement.** The first version of a domain fires `notifications/resources/list_changed`. Only
version 2 and later fire `notifications/resources/updated`. Seeding fires neither.

**Why.** `updated` is the signal that makes an assistant stop mid-sentence and retract. If
creation fired it, the assistant would retract a sentence it never said about a fact it never
had — the product's one dramatic moment spent on noise. A client subscribed to a URI that did not
exist a moment ago also has nothing to re-read *against*.

**Where enforced.** `packages/live-resources/src/store.ts › publish()` branches on whether a
previous version exists. `src/server.ts` arms `list_changed` only after `resources/list` has
actually been SERVED — `notifier.armListChanged()` in the list handler — so the records `seed()`
writes at startup are silent.

**History, because the old mechanism is still worth knowing.** An earlier draft of the paragraph
above named a microtask flag. That mechanism is gone and the reason it went is **F-012**: a
notification sent before any transport is attached fails silently, so the flag was untestable — the
test written to prove it worked would have passed with the guard deleted. Arming on the first list
actually served is the notification's own meaning, and unlike the flag it is observable.

**Asserted by.** `test/store.test.ts` — *"fires updated only where seeding actually supersedes
something"*, *"fires updated on a revision, with the unversioned uri"*, *"does not apply the staged
revision"*; `test/server.test.ts` — *"stays silent about list changes until a list has actually been
served"* at the package level, and the seeded-with-a-host-attached case in this repo's server suite.

---

### I-9 · A notification carries a URI, never content

**Statement.** `notifications/resources/updated` delivers only the unversioned URI. The new value
is obtained by the client issuing `resources/read`, which re-enters I-1.

**Why.** If the notification carried the value, the authorization decision would move to *send*
time on a subscription created earlier, and a scope revoked in between would deliver content the
principal no longer holds. Carrying only the URI means every byte of content passes through
`read()` exactly once, under the caller's scopes at the moment it asks.

**Where enforced.** `packages/live-resources/src/store.ts › publish()` calls listeners with a URI
string; `packages/live-resources/src/notifier.ts › ResourceNotifier` forwards to
`sendResourceUpdated({ uri })` and only for URIs present in the `subscriptions` set, which
`src/server.ts`'s `resources/subscribe` handler can only add to after `store.read()` succeeds —
**and** only when the `canNotify` guard, wired in `src/server.ts`, still finds the current principal
holds the scope for that URI's audience. The same question is asked a third time on the way back
out of the replay buffer: `src/http.ts › MemoryEventStore.replayEventsAfter()` runs every stored
frame through `replayAllowed()` before handing it to a resumed stream.

**Asserted by.** `test/server.test.ts` — *"refuses a subscription to a resource the principal
cannot read"* (the authorization gate on the way in), *"delivers resources/updated to a subscriber
when the physio writes"*, *"stops delivering after unsubscribe"*, and *"does not log an internal
revision to a user-scoped host"* — the last one covering the second channel, where a URI would
otherwise escape the partition without any content escaping with it. `test/http.test.ts` —
*"withholds an internal URI from a resume whose principal has narrowed"* covers the third path,
the one a dropped stream reopens.

**Residual, rewritten because it closed.** This used to read: *"the fact that something changed is
not re-authorized at send time … the code does not close it and we do not pretend otherwise."* That
was true and it was a real leak — a principal whose scope narrowed mid-session kept receiving the
URI of a resource it could no longer read, which is a change-frequency side channel on a URI whose
very existence `read()` refuses to confirm. It is closed: the notifier takes a `canNotify` guard and
`src/server.ts` supplies one that re-checks the current principal's scope against the URI's audience
at SEND time, mirroring what `logRevision()` already did on the second channel.

The half of that residual that named `MemoryEventStore` has since closed too, and it was not
theoretical — it was reproducible against a running server, and it defeated `canNotify` entirely
for anyone willing to drop a stream and reconnect. `replayEventsAfter()` takes a `canReplay`
predicate; `createHttpServer` supplies one that re-authorizes each stored frame against the
principal the resuming request carries, read from the same `AsyncLocalStorage` the GET handler
already populates. Withheld frames are counted (`events.replaysWithheld`) rather than dropped
silently into nothing.

What remains is narrower. The guard reads the principal at the moment the notification is
dispatched, or at the moment the resume asks; a scope that narrows *between* dispatch and delivery
is not re-checked, because there is nothing to re-check it against once the frame is on the wire.

---

### I-10 · A prompt cannot emit reasoning-only content, even for a caller that could read it

**Statement.** `prompts/get brief_carer` assembles its briefing through a principal **narrowed**
to the speakable scope. A caller holding both scopes still gets a briefing containing no internal
content.

**Why.** This is the one place inside the server where the partition is not simply "the caller
does not have the scope". A dual-scope reasoning host legitimately holds `care.read.assistant`,
and a carer handover is exactly the artefact where internal context would leak by accident. Doing
it as a narrowed principal rather than a post-hoc filter means there is **no code path** in the
handler that can read a `care-internal://` record — the partition is a property of how the text is
built, not a check applied to it afterwards.

**Where enforced.** `src/server.ts`'s `GetPromptRequestSchema` handler constructs
`speakableOnly = { sub, scopes: caller.scopes.filter(s => s === SCOPE.user) }` and passes it to
every `store.list()` and `store.staleness()` call in the handler.

**Asserted by.** `test/server.test.ts` — *"cannot emit assistant-only text even for a caller
holding BOTH scopes"*, which is the only shape of this test worth writing: a dual-scope caller is
the adversary here, and a single-scope caller would pass trivially.

---

### I-11 · Pagination is resumable by key, and an unrecognised cursor fails loudly

**Statement.** `resources/list` is cursor-paginated at `RESOURCE_PAGE_SIZE = 3` over a
URI-sorted list. The cursor carries the last URI emitted, not an offset. A cursor the server did
not issue produces `-32602`, not page one.

**Why.** This server's resource list changes while a client pages — a new domain can appear
between two pages and fire `list_changed`. An offset cursor would silently skip a resource into
the gap; a key cursor resumes correctly. Failing loudly on an unrecognised cursor matters because
the alternative, resetting to page one, loops a client forever. MCP 2025-11-25 pins none of this:
it defines the cursor as opaque and stops. `FRICTION.md` **F-007**.

The page size is small on purpose. The demo store holds **eight** records and `resources/list`
serves **nine** entries — the eight plus the `ui://unsay/echo` card (I-16) — so every client walks
three pages and the cursor is exercised on the judged path rather than on a code path nobody
reaches. `test/store.test.ts` — *"seeds exactly eight records"* — pins the first number; the second
is that number plus the one card, asserted in `test/server.test.ts`.

**Where enforced.** `src/server.ts › encodeCursor()/decodeCursor()` and the
`ListResourcesRequestSchema` handler. Authorization runs first — `store.list(principal)` — so a
page can never contain, and a cursor can never name, a URI the caller may not see.

**Asserted by.** `test/server.test.ts` — *"pages at RESOURCE_PAGE_SIZE and the cursor round-trips
to the rest"*, *"rejects a cursor it did not issue rather than silently restarting"*, *"never pages
an internal uri to a user-scoped principal"* (authorization survives pagination, which is where a
partition usually springs a leak).

---

### I-12 · A write is authenticated over the raw bytes, before parse

**Statement.** `POST /write` accepts either an HMAC-SHA256 signature over `timestamp.rawBody`
with a 300 s freshness window, or a bearer token carrying `care.write`. Signature verification
happens on the **bytes as received**, before `JSON.parse`.

**Why.** Verifying a signature against a re-serialised parse of a body is the classic way to make
a signed webhook forgeable: key order, unicode escaping and duplicate keys all survive
parse/stringify differently, so the bytes that were signed and the bytes that are stored can be
made to differ. Putting the timestamp *inside* the MAC means a captured request cannot be
replayed under a fresh timestamp.

**Where enforced.** `src/http.ts › handleWrite()` reads the body with `readBody()` into a
`Buffer`, verifies, and only then parses. `writeSigningMaterial()` and `signWriteBody()` are
exported so a client signs exactly what the server verifies. Comparisons use
`timingSafeEqual` behind a length check.

**Asserted by.** `test/http.test.ts` — *"rejects a body mutated after signing, and audits the
attempt"* (the exact forgery this design exists to stop), *"rejects an unsigned write"*, *"rejects a
replayed request whose timestamp is outside the skew window"*, *"rejects a bearer write without
care.write"*, and *"accepts a correctly signed write and delivers resources/updated to a
subscriber"* — the positive case has to be there too, or the negatives could all pass on a route
that rejects everything.

---

### I-13 · A client cannot name its own scopes

**Statement.** Scopes come from a verified token payload and from nowhere else. `alg` must be
`HS256`, so an unsigned or two-segment token is rejected before any comparison. `aud` must equal
this server's resource identifier (RFC 8707).

**Why.** Every scope check in `src/store.ts` is only as strong as the step that decides which
`Principal` a request is. And the `aud` check is what stops a token minted for another MCP server
in the same ecosystem from being spendable here — without it, a compromised sibling service is a
route into Ray's record.

**Where enforced.** `src/http.ts › verifyToken()`, with `TokenError` failures typed as
`malformed | bad_alg | bad_signature | expired | wrong_audience | no_scopes`. Bearer tokens are
accepted in the `Authorization` header only (`bearer_methods_supported: ["header"]`) — a
query-string token would end up in access logs.

**Asserted by.** `test/http.test.ts` — *"rejects an unsigned token — the signature is not
optional"*, *"rejects a token signed with the wrong secret"*, *"rejects an expired token"*,
*"rejects a token minted for another resource"* (the RFC 8707 check), *"will not take a scope list
from the client — scopes come from the signature"*, and *"401s an unauthenticated MCP request and
points at resource_metadata"*.

---

### I-14 · Every write attempt is attributable, and no audit row can carry attacker bytes

**Statement.** Accepted and rejected writes both append a row of
`{ at, actor, uri, outcome, reason, via }`. `actor` is the **verified** principal wherever the
request carried one — never a name taken from the body. `reason` is a closed union.

**Why.** The rejected row is the one that matters — a stolen or malformed clinician key leaves a
trail here and nowhere else. `reason` is a union rather than free text so that a row has **nowhere
to put** a presented signature, a bearer token, or any other attacker-supplied bytes. That is a
stronger guarantee than remembering to redact.

**Where enforced.** `src/audit.ts › AuditLog.append()`; no method on `AuditLog` mutates or removes
a row. `src/http.ts › handleWrite()` appends on every path including `body_too_large`, which fires
before the body is even fully read.

On the bearer path the actor is `p.sub` from the verified token. It used to be `body.authorId`,
which silently discarded the one identity the request had actually proved: a `care.write` holder
could name any clinician as the author, and the row recorded the impersonated name while the real
principal appeared in no row at all. That made this invariant false on precisely the path where it
was strongest. The claimed author still reaches the *record* — see T-4, where one shared write
secret means `authorId` is claimed rather than proven — but the *trail* now says who presented a
credential.

**Asserted by.** `test/http.test.ts` — *"never records a credential in an audit row"*, *"records the
verified token subject, not the authorId in the body"*, *"still lets the claimed author reach the
record, which the chain then freezes"*, and the rejection paths above, each of which asserts the
audit row it should have produced.

---

### I-15 · Proof artifacts are reproducible

**Statement.** `seed()` produces byte-identical version hashes on every run; the receipts in
`docs/proof/` are regenerated by the same scripts a judge runs.

**Why.** A committed receipt that cannot be regenerated is a screenshot.

**Where enforced.** `src/seed.ts` derives every timestamp from an injected clock defaulting to the
pinned constant `DEMO_NOW`; there is no `Date.now()` in the seed path.

**Asserted by.** `test/store.test.ts` — *"produces identical hashes across runs"*, *"seeds exactly
eight records"*, *"seeds the superseded day-1 weight-bearing instruction"*. `npm run seed` reseeds
twice and exits non-zero if a single version hash differs, and refuses to report success over an
empty comparison. `scripts/fresh_clone_check.sh` clones to a temp directory with empty state and
runs the suite, `typecheck`, `seed`, `probe`, `verify`, `e2e`, `probe:resume`, `bench` and a second
`e2e` with an envelope configured — verbatim, so the invariant holds for a stranger and not only
for this working tree.

---

### I-16 · The device card is served through the protocol, not beside it

**Statement.** `ui://unsay/echo` is an MCP resource: it appears in `resources/list` for every
authenticated principal and `resources/read` returns the Echo Show card as renderable HTML under
the MCP Apps extension's mime type. It is the same bytes `GET /echo.html` serves.

**Why.** The Alexa+ rules name "a basic MCP wrapper around an existing API" as the *obvious* idea
and "media support (cards, carousels), MCP Apps, Agent Skills" as the creative bar. The card
already existed and was reachable only over an HTTP static route — which is not an MCP surface at
all, and would work identically if this were not an MCP server.

**Where enforced.** `src/ui_resource.ts` holds the URI, the mime type, the `_meta` keys and the
single `readFileSync` of `web/echo.html`; `src/server.ts` appends the descriptor in the
`resources/list` handler and short-circuits `resources/read` before the store is consulted, because
`ui://` is not a scheme the care partition issues. `src/http.ts` serves the same file at
`/echo.html` from the same path, so there is one file and nothing to drift.

**Asserted by.** `test/server.test.ts` — *"is listed alongside the facts, so a host discovers it the
usual way"*, *"reads back as renderable HTML under the extension mime type"*, *"carries no
assistant-audience content, because Ray can see the card"*, *"binds the fallback tool to the
template, so a host knows what to render"*. `scripts/e2e.ts` reads it over Streamable HTTP and fails
the run if the bytes are not HTML.

**Limit, and it is the whole of F-013.** No host we can reach implements the extension, so the
`_meta` template binding on `whats_changed` is **shaped and unexercised**. The resource is proven;
the binding is not. Read it exactly as the KMS provider is read.

---

### I-17 · The retraction is a rendered artifact, not a string in a document

**Statement.** The spoken retraction is produced by `renderRetraction()` from the two record
versions, and is delivered to the host on `_meta['unsay/retraction']` of a `resources/read` and on
each `whats_changed` entry. Nothing that quotes it writes it by hand.

**Why.** For a voice device the interaction model IS the sentence, and this one existed as three
different literals — in `DEMO.md`, in `web/index.html` and in `scripts/e2e.ts` — generated by
nothing and covered by no test. A sentence that no code produces is a sentence that cannot be
regression-tested, and the ordering inside it is a safety property: withdraw first, name what is
being withdrawn, then the new value with its author and age, then a gloss of the clinical language.
Leading with *"that changed thirty seconds ago"* buries the instruction a frightened person acts on.

**Where enforced.** `src/retraction.ts › renderRetraction()`, built from record fields only, with a
closed `GLOSSARY` whose entries restate the clinician and add no guidance. `src/server.ts` attaches
it in the `resources/read` handler when a previous version exists, and to each `whats_changed` entry
— which is why that tool also returns `previousValue` and `previousVersion`: a host on the fallback
path never read v1, and without the superseded sentence it can state a fact but cannot withdraw one.

**Asserted by.** `test/retraction.test.ts` — *"opens with the stop, not with the metadata"*, *"names
the sentence being withdrawn, so there is one instruction to drop"*, *"glosses every jargon phrase
the new value contains"*, *"adds no guidance of its own — every gloss restates the clinician"*.
`test/server.test.ts` — *"returns the superseded value and the rendered retraction"*.
`web/web.test.ts` — *"matches renderRetraction() for the seeded revision, word for word"*, which
recomputes the landing page's copy and fails if the page and the server ever differ.
`scripts/e2e.ts` prints the server's own output rather than a literal.

**Limit.** Whether the host says it is the host's decision. MCP settles the notification's delivery
and not its consequence (F-003, T-2). We can make the right words available and no more.

---

### Coverage gaps

Every invariant above now has at least one assertion behind it. These are the edges that do not,
listed because an unasserted edge is a hope, and hiding the list is worse than the gap.

One gap that used to be here is closed: encryption and the HTTP surface are no longer proven
only apart. `test/http.test.ts` — *"names the provider, key, IV and tag of sealed bytes without
holding the key"* — runs the server over a sealed store and reads the at-rest receipt back off
`GET /verify`, and `scripts/fresh_clone_check.sh` runs the whole end-to-end sequence a second
time with `UNSAY_KEY_PROVIDER=local`.

| Gap | What is missing |
|---|---|
| I-2 **timing** | Not measured, and no attempt is made to constant-time the path. `-32002` is constant in shape, not in duration. |
| I-9 **residual** | Closed and asserted on all three paths — `test/server.test.ts` *"does not deliver an internal updated to a downgraded session"*, the package's *"re-checks authorization at SEND time, not only at subscribe time"*, and `test/http.test.ts` *"withholds an internal URI from a resume whose principal has narrowed"* for the `Last-Event-ID` replay that used to walk around both. What is still unasserted is the narrower window inside a single dispatch: a scope that narrows between dispatch and delivery. |
| **Resumability** | `Last-Event-ID` replay is exercised by `scripts/probe_resume.ts` with a committed receipt (`docs/proof/resume.json`: stream dropped, three revisions written into the dark, all three replayed in order on reconnect) — a script, not a test, so it is still outside `npm test`. It is now run by `scripts/fresh_clone_check.sh` and by `scripts/check_submission_readiness.py`, which also asserts the committed receipt's verdict. |
| **Resumability, the gap under it** | A client that has received no event on the standalone SSE stream holds no `Last-Event-ID` and cannot resume at all — the SDK writes no priming event on that stream (FRICTION F-010). A correction published before the first event on a fresh stream is stored and not replayable. Unfixable from this side; disclosed rather than closed. |
| **Key rotation** | `Envelope.openAsync()` unwraps whatever key the stored bytes name, and `test/envelope.test.ts` covers it at the provider level. No test rotates a live store's key and reads old records back through it. |
| **KMS** | `KmsKeyProvider` has never been executed against a live CMK — the account is under the hold logged as F-004. Its SigV4 canonical request, signed-header list, endpoint and target are asserted; that AWS accepts them is not. |
| **MCP Apps binding** | The `ui://unsay/echo` resource is served, listed and read over the wire by `npm run e2e`. The `_meta` template binding that tells a host to render a tool result INTO it has never been honoured by a host, because no host we can reach implements the extension. F-013. |
| **The browser host** | `web/web.test.ts` now slices echo.html's own MCP client out of the page and runs it against a live server — initialize, pagination, subscribe, the SSE framer, the correction. What is still unverified is **rendering**: layout, animation timing and the 1280×800 device fit are checked by eye, not by a headless browser. |

The suite is `test/store.test.ts`, `test/envelope.test.ts`, `test/server.test.ts`,
`test/http.test.ts`, `test/retraction.test.ts`, `test/docs.test.ts`, `web/web.test.ts` and
`packages/live-resources/test/live-resources.test.ts`. `npm test` prints the exact count and the README headlines it; this document
deliberately does not repeat the number, because a count copied into a second place is a count
that goes stale. What matters here is which assertion backs which invariant, and that is named
next to each one above.

---

## Threat model

The asset is a partition: facts about one patient, some speakable to him and some not, all of
which change without warning.

### T-1 · A compromised or non-compliant MCP client that ignores `annotations.audience`

**Capability.** Reads everything it is served, ignores every annotation, speaks anything it
receives.

**Mitigated.** Fully, for leakage. A user-scoped client is never *sent* internal content, never
sees an internal URI in `resources/list`, cannot page one into view, cannot discover one by
probing, and is not told over the log channel that one changed (I-1, I-2, I-4, I-11). It cannot
leak what it does not hold. The annotation being advisory (**F-002**) and being dropped on reads
(**F-005**) is precisely why the design never relies on it.

**Residual.** It can still speak a `care://` fact while ignoring the `[STALE — …]` header. We can
refuse to give a client what it must not say; we cannot make it say what it must.

### T-2 · A client that never subscribes

**Capability.** Fully compliant, but does not implement `resources/subscribe`, or implements it
and never re-reads on `updated` — which MCP 2025-11-25 permits, since it specifies the
notification's delivery and not its consequence (**F-003**).

**Mitigated.** Partially, by paths built from the first commit rather than bolted on: the
`whats_changed` tool with an `outputSchema` returning every revision since a timestamp with its
age and author; the server `instructions` field telling the host in plain language to call it
before answering any care-plan question; and a second `notifications/message` channel carrying
the same revision facts for hosts that surface logs. `scripts/e2e.ts` fails the run if the tool
does not return exactly the one revision just made — an unexercised fallback is
indistinguishable from a missing one.

**Residual.** Nothing compels a host to call the tool or read `instructions`. This is the one
risk in the design that no amount of server engineering removes.

### T-3 · An attacker with write access to storage

**Capability.** Rewrites stored records directly, bypassing `publish()` and therefore bypassing
I-3; or relocates a ciphertext from one record to another.

**Mitigated.** Relocation is defeated by AAD binding (I-6) and proven by
*"DEFEATS a cross-record paste in storage itself"*. Corruption is detected by the GCM tag at read
and by chain replay at `verify()` (I-5). With no envelope configured, detection only — and
`startupLine()` prints the word PLAINTEXT so nobody can be confused about which mode is running.

**Not mitigated.** An attacker holding storage **and** the data key can re-seal under the correct
AAD and recompute every downstream hash; the chain will verify clean. What defeats that is a
signature over the chain head from a key the attacker does not hold, and there is none. Neither
is there durable storage: the store is an in-process `Map`, so "write access to storage" today
means "code execution in the process", which is a larger compromise than this row describes.

### T-4 · A forged clinician write

**Capability.** Posts a plausible revision — *"full weight-bearing as tolerated"* — that an
assistant then speaks to a post-operative patient with a named clinician's authority. The
highest-consequence attack on the product.

**Mitigated.** HMAC-SHA256 over `timestamp.rawBody` verified **before parse**, constant-time
comparison, a 300 s freshness window, and `writtenAt` taken from the server clock so a write
cannot be backdated (I-12, I-7). Rejections are audited with a typed reason and never carry the
presented signature (I-14). The alternative writer path — a bearer token — must carry the
`care.write` scope, which is advertised in the protected-resource metadata and enforced.

**Residual, stated plainly.**

- **No nonce cache.** A captured signed write is replayable for up to 300 s. The window is
  bounded and named; it is not zero.
- **A live stolen key writes valid updates**, exactly as in any signed-webhook system.
  Unmitigated by design.
- **One shared write secret**, from `UNSAY_WRITE_SECRET`, not per-author keys. `authorId` is
  therefore *claimed in the body*, not proven by the signature: the signature proves *a* holder of
  the write secret wrote this, not *which clinician*. The hash chain then makes that claimed
  authorship immutable — immutable, not authentic. On the **bearer** path an identity IS proved, and
  the audit row records it (I-14); the record still carries the claimed author, so the two can
  disagree, and a row where they disagree is the row an investigator wants.
- **Defaults exist.** `DEV_WRITE_SECRET` and `DEV_TOKEN_SECRET` are used when the environment
  variables are unset, and the server announces it at startup when it is running on the default
  token secret. A deployment that ignores that line is unauthenticated in practice.
### T-5 · A token with the wrong audience, or a lifted token

**Capability.** Presents a token issued for a different resource server, or replays one captured
from a legitimate host.

**Mitigated.** `verifyToken()` requires `alg: HS256` (so `alg: none` and two-segment tokens die
before any comparison), a valid signature, an unexpired `exp`, an `aud` equal to this server's
resource identifier (RFC 8707), and a non-empty scope list with a `sub` (I-13). Scopes are read
from the signed payload and can never be asserted by a client. `401` responses carry a
`WWW-Authenticate` header naming `resource_metadata`, and
`/.well-known/oauth-protected-resource` is served at both the bare path and the `/mcp`-suffixed
path RFC 9728 specifies.

**Residual.**

- **There is no separate authorization server.** Tokens are HS256 under a shared secret and are
  minted by `mintToken()` in the same file that verifies them. No JWKS, no asymmetric keys, no
  token endpoint, no dynamic client registration, no consent. This is a *resource server*
  implementing verification correctly against tokens it also issues — which is honest for a
  hackathon build and is not an OAuth deployment.
- **No replay cache.** A `jti` is minted and never checked, so a lifted token is spendable until
  `exp` (default one hour).
- **No revocation.** I-9's residual follows from this.
### T-6 · Existence probing

**Capability.** A patient-facing token enumerates domains to learn what clinical concerns exist,
without reading any.

**Mitigated.** I-2, extended to every channel: `read()`, `list()`, pagination, the public
`/verify` route, and the revision log.

### T-7 · The confused deputy — a host that legitimately holds both scopes

**Capability.** The reasoning host holds `care.read.user` **and** `care.read.assistant`, because
that is the point: internal facts exist to shape the answer. Having read
`care-internal://ray/risk`, it paraphrases *"family disputes the discharge plan"* into speech.

**This is the residual risk of the entire design.** Concretely, in this repo: `scripts/e2e.ts`
grants its `alexa-host` principal both scopes. The partition, as demonstrated, protects Ray
against a *user-scoped* client — the patient-facing surface, a family member's app, a logging
sidecar, a second host — and does **not** protect him against the reasoning host itself choosing
to speak.

**Partially mitigated in one place, and only one.** `prompts/get brief_carer` narrows the caller's
principal to the speakable scope before assembling anything (I-10), so the one server-generated
artefact intended for a human other than the model cannot contain internal content even for a
dual-scope caller. That is the shape a fuller mitigation would take, applied to a single surface.

What would actually close it is an architecture where the speech surface is a **different
principal** from the reasoning surface, holding only `care.read.user`, with the reasoning host
forbidden from emitting text directly. That is a host-side property. MCP gives a server no way to
require it.

We say this out loud because a judge will open `scripts/e2e.ts` and ask.

### What Unsay does **not** defend against

A threat model with no out-of-scope section is marketing.

- **A malicious host holding `care.read.assistant`.** T-7. Out of reach from the server.
- **A compromised clinician credential.** T-4.
- **Model behaviour.** There is no output filter. Nothing inspects what the assistant is about to
  say for traces of internal content — and adding one would be a second, weaker copy of a boundary
  already enforced at the source.
- **Timing and traffic analysis.** `-32002` is constant in *shape*, not in *time*. Notification
  timing reveals that a resource changed to anyone who can observe the stream (I-9).
- **Denial of service.** A 256 KiB body cap on `/write` and a bounded event store, and that is
  all: no rate limiting, no quotas, no backpressure on subscriptions, no connection limits.
- **Key management.** No rotation policy, no revocation, no HSM story. The envelope has a
  rotation *path* (`openAsync()` unwraps whatever key the bytes name) and no rotation *process*.
- **Multi-tenancy.** The store is keyed `patient/domain` and every principal is scoped to the
  whole store. There is no per-patient authorization; a second patient would need one and it does
  not exist.
- **Transport security below TLS.** Assumed, not provided. Nothing in this repo terminates TLS.
- **The clinical content itself.** Unsay relays what a clinician wrote. It does not generate,
  check, or reason about medical guidance, and it is not a medical device.
- **Anyone within earshot.** The Echo Show is in a bedroom. The audience partition is a partition
  of *facts*, not of *listeners* — a daughter in the doorway hears whatever is spoken. That is a
  real limit of a voice-first product and no server-side control touches it.

---

## Failure modes

### The host does not support `resources/subscribe`

Nothing errors. The server declares `resources: { subscribe: true, listChanged: true }`
regardless; a host that never sends `resources/subscribe` simply never enters the `subscriptions`
set and `sendResourceUpdated` is never called for it. Corrections remain reachable through
`whats_changed` and the log channel.

The failure is **silent by construction**, which is why `scripts/probe_subscribe.ts` exists and
why it *records* the negotiated capability block into `docs/proof/probe_subscribe.json` rather
than asserting it. A capability a host does not have should be a recorded fact, not a crash.

### The notification arrives after the assistant has finished speaking

Then nothing retracts, and Ray acts on the old instruction. The product has no mechanism to
interrupt speech that has already ended and does not claim one.

What bounds the risk is a measured number. `scripts/bench.ts` measures clinician-write →
client-holds-new-value end to end over Streamable HTTP, and `npm run bench -- --n 200` regenerates
`docs/proof/bench.txt` and `docs/proof/bench.json`, which are the authoritative copies. The
result this document depends on is the pass/fail one — **every run lands inside the speech
window** — and `bench.ts` exits non-zero if even one revision does not. The p50/p95/max figures
are deliberately not repeated here: they change on every run, and a latency quoted in two places
is a latency that will be wrong in one of them.

Three honesties about that number:

1. **Loopback.** Both processes are on one machine. The script prints this and refuses to let the
   figure be quoted as production.
2. **The window is an assumption.** 3400 ms is 12 words at ~150 wpm, a constant in
   `scripts/bench.ts`. It is not a measurement of Alexa+ speech synthesis, and a shorter real
   utterance shrinks the margin.
3. **The measurement stops at the client.** It ends when the MCP client holds the new value. It
   does not measure the host deciding to re-read, the model deciding to retract, or TTS producing
   the retracting audio. Those belong to the host and are not ours to measure.

### The notification arrives and the host does not re-read

MCP specifies delivery, not consequence (**F-003**). The fallback is `whats_changed`; the honest
position is T-2.

### The stream drops mid-answer

`src/http.ts › MemoryEventStore` stores each notification whether or not a stream is attached and
replays it — to a principal that still holds the scope for the URI it names, checked again at
replay time — on `Last-Event-ID`, so a correction survives the network dropping under an Echo Show
mid-sentence. `scripts/probe_resume.ts` proves it end to end and commits the receipt: a revision is delivered
live, the stream is dropped, **three** further revisions are written while it is down, the client
reconnects with `Last-Event-ID`, and all three are replayed in order
(`docs/proof/resume.json`). Three and not one on purpose — a replay that delivered only the LAST
missed notification would pass a single-revision probe and lose the middle of a correction sequence
in the field. The store is in-memory and capacity-bounded
at 2048 events: a long enough outage, or a process restart, loses the replay.

### A scope is revoked between subscribe and revision

Closed, and this paragraph is rewritten rather than deleted because it was wrong twice over. It
used to end *"not exploitable in this build, where scopes are fixed per session"*. Scopes are not
fixed per session: `src/http.ts` re-reads the principal on every request and updates
`session.principal`, which is the whole reason `canNotify` exists. And when the live path was
guarded, the **replay** path was not — resuming with `Last-Event-ID` under a narrowed token of the
same subject handed back the internal URI, its version, its author and its hash-chain links. Both
are now re-authorized at send and at replay (I-2, I-9), content was protected throughout by
`read()`, and the residual is the dispatch-to-delivery window, which nothing can re-check.

### The process restarts

Everything is lost. `LiveResourceStore` is an in-process `Map`, the audit log's durable half is an
optional JSONL sink, and the event store is memory. A restart re-seeds and the chain history is
gone. Durable storage is [not built](#not-built).

### A version or a cursor is requested that does not exist

A missing version gives `-32002`, like everything else (I-2). `parseUri()` rejects a malformed
version segment — `care://ray/weight_bearing/3` returns `null` rather than being read as `v3`, so
a typo fails closed instead of silently serving the latest. A cursor the server did not issue
gives `-32602` (I-11).

---

## What Unsay does not claim

- **Not medical advice.** Unsay relays what a named clinician wrote, with its age and its author.
  It generates no guidance and makes no clinical decision.
- **Not a guarantee that the correction is spoken.** It guarantees the correction is *available*,
  provably, within a measured latency. The last step belongs to the host (T-2, F-003).
- **Not protection against the reasoning host itself** (T-7).
- **Not a production latency figure.** The bench is loopback and says so in its own output.
- **Not an OAuth deployment.** A correctly-implemented resource server with a symmetric,
  self-issued token (T-5).
- **Not per-clinician write authenticity.** One shared write secret (T-4).
- **Not durable.** In-process state, no persistence.

---

## Not built

`ARCHITECTURE.md` is generated by `scripts/gen_architecture.ts` from actual handler registrations
and `package.json`, precisely so it cannot drift into fiction. Read it for the authoritative list
of what exists. As of this writing the repo has **no** DynamoDB, Lambda, KMS-backed deployment
(the KMS *client* is real; no AWS resources are provisioned by this repo), no persistence layer,
no authorization server, no rate limiting, and no ML model of its own — the reasoning model
belongs to the host, by design.

This repo is under active development by several concurrent workstreams. Where a mechanism above
is implemented but not yet asserted, it is in the gap table rather than described as proven. When
an assertion lands, its row leaves that table and the corresponding residual-risk paragraph must
be **rewritten, not quietly deleted**.
