# DEMO — reproduce everything from an empty clone

No flags. No `MOCK=`, no `OFFLINE=1`, no `--dry-run`. If any command below needed a flag to
disable the thing being judged, this submission would be worthless.

**Requirements:** Node ≥ 22 (uses native TypeScript stripping) and `curl`. Nothing else — no
build step, no database, no cloud account, one runtime dependency.

```bash
git clone https://github.com/edycutjong/unsay.git && cd unsay
npm install
```

Everything below runs against that clone with no further setup. Five commands prove the
product, the sixth opens it in a browser, and the seventh is the two artifacts that exist only
because the track is Alexa+.

---

## 1 · The correction mechanism is real

```bash
npm run probe
```

Stands up an MCP server and a spec-compliant client over **Streamable HTTP**, subscribes,
revises a resource, and measures how long the notification takes to arrive.

**Expected:**

```
unsay · day-1 probe · Streamable HTTP

  server capabilities.resources : {"subscribe":true,"listChanged":true}
  subscribe supported           : YES
  read (before)                 : "Partial weight-bearing, about half your body w…"
  subscribed                    : care://ray/weight_bearing

  notifications/resources/updated RECEIVED
    uri                         : care://ray/weight_bearing
    write → notification        : 0.88 ms
    re-read returns new value   : YES
    author now                  : Sarah Okafor, physio

  VERDICT: correction lands mid-sentence (< 3400 ms): YES

  receipt → docs/proof/probe_subscribe.json
```

Exit code 0. The `0.88 ms` will differ on your machine; nothing else should. Receipt:
`docs/proof/probe_subscribe.json`, which records the measured figure to three decimals.
`test/docs.test.ts` checks every label in that block against the format strings
`scripts/probe_subscribe.ts` actually prints.

---

## 2 · The safety properties hold

```bash
npm run verify
```

This asserts the reads that **must fail**, fail. It is not a happy-path check. Sections 1–5 and 7
run in process; sections 6, 8 and 9 stand up a real HTTP server and attack it. Section 9 is the
one that takes **no injected store and no injected clock** — the defaults `npm start` uses — because
a defect in the entrypoint's own pairing of those two is invisible to every gate that supplies both.

**Expected — 34 assertions, all ✓:**

```
1. audience partition
  ✓ care-internal://ray/risk unreachable with care.read.user
  ✓ care-internal://ray/adherence unreachable with care.read.user
  ✓ care-internal://ray/risk readable with care.read.assistant
  ✓ care-internal://ray/adherence readable with care.read.assistant

2. existence is not leaked
  ✓ list() with user scope returns no care-internal:// URI — 5 user URIs
  ✓ care:// URI cannot reach an assistant-only record

3. version chain
  ✓ weight_bearing chain intact (2 versions)
  ✓ tampering v1 breaks the chain and is located — broken at v1

4. self-announcing staleness
  ✓ anticoagulant is past its stale_after — stale_after 2026-10-04T09:14:00.000Z, age 9.0d
  ✓ exercise (fresh) is NOT flagged stale — age 1.0d

5. audience cannot be changed by a later write
  ✓ publishing risk as audience:user is refused

6. OAuth scope boundary over HTTP
  ✓ POST /mcp with no token is refused — HTTP 401
  ✓ a token with an escalated scope claim is refused — HTTP 401
  ✓ care-internal://ray/risk unreachable over HTTP with care.read.user
  ✓ resources/list over HTTP returns no care-internal:// URI, on any page — 5 care:// URIs + the ui:// card, over every cursor page
  ✓ care-internal://ray/risk readable over HTTP with care.read.assistant
  ✓ the negotiated protocol version is at least 2025-11-25 — 2025-11-25
  ✓ GET /verify without a token lists no care-internal:// chain — 5 public chains

7. encryption at rest binds a ciphertext to its slot
  ✓ the stored value is ciphertext, not the sentence — 203 bytes at rest
  ✓ a ciphertext pasted from care-internal://ray/risk fails to decrypt
  ✓ and the chain reports it as broken at that exact version — broken at v1
  ✓ the same bytes still open under their own identity

8. the write path refuses what it cannot verify
  ✓ an unsigned write is refused — HTTP 401
  ✓ a body mutated after signing is refused — HTTP 401
  ✓ a signature under the wrong key is refused — HTTP 401
  ✓ a correctly signed but stale request is refused — HTTP 401
  ✓ a correctly signed write is accepted — HTTP 200
  ✓ every refusal left an audit row — 4 rows for 4 refusals
  ✓ no audit row carries a credential, a MAC or a bearer token
  ✓ every refusal returns the same body, naming no cause — {"error":"unauthorized"}

9. the live entrypoint serves an honest age
  ✓ no resource reports a negative age on the default clock — 4 headers, all forward in time
  ✓ the anticoagulant record is past its review date on the default clock — [STALE — last changed 9 days ago by Dr Mensah, GP; say this age aloud]
  ✓ the record's own text names a stop date that has already passed — the stop date in the value is 4 days behind the default clock
  ✓ a fresh record is NOT flagged stale on the default clock — [changed 1d ago by Sarah Okafor, physio]

PASS — 0 failing assertion(s)
receipt → docs/proof/verify.json
```

Exit code 0. **If any assertion fails, the clinical-safety claim is false** and the build should
not be submitted.

Section 7 is the one worth pausing on: it pastes the ciphertext of `care-internal://ray/risk`
into `care://ray/weight_bearing`, which is what an attacker who owns the database does and what
no scope check can see. The AES-256-GCM AAD binds every record to
`patient|domain|version|audience`, so the bytes refuse to decrypt in the wrong slot.

Section 9 is the one that exists because of a defect. The server used to seed its store on the
pinned demo clock and then read the wall clock, so `npm start` served `[changed -32d ago by …]`
and the self-announcing-staleness feature was dead on the live process — while 184 tests, and
every other section above, stayed green, because they all pass an explicit clock. This section
takes the defaults and reads the headers a judge would see.

Receipt: `docs/proof/verify.json`, which carries every assertion, the in-process/over-HTTP split,
and the verdict. `web/web.test.ts` compares the landing page's assertion count against it.

---

## 3 · The whole demo, as code, over the real server

```bash
npm run e2e
```

Runs the exact sequence the video shows against `createHttpServer()` — the same process
`npm start` runs — with a real Bearer token, cursor-paginated listing, a blob read, the
audience partition attacked from Ray's own host, the physio's correction arriving through the
**signed** `POST /write`, and the public `/verify` route.

**Expected:**

<!-- e2e:begin — written by `npm run e2e`, from the run that wrote the receipt. Do not edit by hand. -->
```
unsay · end-to-end · the demo as code

  at-rest: PLAINTEXT — no envelope configured (set UNSAY_KEY_PROVIDER=local|kms)
  no token                  HTTP 401 · Bearer realm="unsay"

  protocolVersion           2025-11-25 ≥ 2025-11-25 — Alexa+ track minimum
  capabilities.resources    {"subscribe":true,"listChanged":true}
  completions · prompts     declared · declared
  logging                   declared
  instructions              present

  templates                 care://{patient}/{domain}/{version}, care-internal://{patient}/{domain}/{version}
  resources/list            9 resources over 3 cursor page(s)
  read  ui://unsay/echo   ← text/html+skybridge · 36769 bytes · MCP Apps card
  agent skill               skill/SKILL.md — 4683 bytes, the same two rules as instructions
  completion {version}      ["v2","v1"]  ← resolved via context.arguments

  RAY   "Can I put weight on it yet?"
  read  care://ray/weight_bearing
        Partial weight-bearing, about half your body weight through the operated leg.
        _meta v2 · prevHash 8396b80c4953…
  read  care-internal://ray/risk   ← audience:assistant · NOT SPOKEN
  read  care://ray/exercise_clip   ← audio/wav · 24044 bytes

  Ray's own host reads care-internal://ray/risk
        -32002 Resource not found — same answer as for a URI that does not exist

  subscribed to care://ray/weight_bearing
  tampered write            HTTP 401 · refused, and says nothing about why

  POST /write               HTTP 200 · v3 · 1 subscribed host(s)
  notifications/resources/updated  1.93 ms
  ALEXA "You can put about half your weight on it—"
        Wait — don’t do that. What I just told you is out of date. I said
        “Partial weight-bearing, about half your body weight through the
        operated leg.” Sarah Okafor, physio changed it just now: “Full
        weight-bearing as tolerated.” In plain terms, full weight-bearing
        as tolerated means you can put as much weight through that leg as
        is comfortable.
        "Take it slowly the first time, and have someone nearby."   ← from care-internal://ray/risk, reason never spoken
  _meta unsay/retraction    rendered by src/retraction.ts, not typed into this script
  v3.prevHash === v2.versionHash  YES — the retraction is auditable

  stale fact                announces its own age
        [STALE — last changed 9 days ago by Dr Mensah, GP; say this age aloud]
  prompts/get brief_carer   speakable only · 873 chars
  fallback whats_changed    1 revision(s) — exercised, not just built
        previousValue       "Partial weight-bearing, about half your body weight through the operated leg."  ← the fallback can retract, not only restate

  notifications/message     1 revision notice(s) delivered on the log channel
  logging/setLevel          notice suppressed at level emergency — 0 log message(s) after the write
                            notifications/resources/updated still delivered: YES

  GET /verify (no token)    5 chains · 8 versions · intact true · 0/5 sealed at rest

  PASS — receipt → docs/proof/live_run.jsonl (20 frames + summary)
```

The `1.93 ms` will differ on your machine and between two runs on this one;
it is the only figure in this block that moves, and `npm run e2e` rewrites this block and the receipt from the same run.
<!-- e2e:end -->

Exit code 0. Receipt: `docs/proof/live_run.jsonl` — 21 lines: 20 frames of the real protocol
exchange and a summary line.

Three of those steps are new and are the ones worth reading. `read ui://unsay/echo` is the Echo
Show card fetched **through MCP** as an MCP Apps resource rather than off a static HTTP route.
`_meta unsay/retraction` is the spoken sentence, rendered by `src/retraction.ts` from the two
record versions — this script prints the server's output and does not contain the wording.
`logging/setLevel` is the eleventh method: the run sets the level to `emergency`, writes again,
and asserts the revision notice is suppressed while `notifications/resources/updated` still
arrives.

**The same run, encrypted at rest:**

```bash
UNSAY_KEY_PROVIDER=local UNSAY_MASTER_KEY=$(npm run --silent keygen) npm run e2e
```

Identical output except three lines — the banner the envelope prints on startup, the same
line inside the run, and the `sealed at rest` count on `GET /verify`:

```
at-rest: AES-256-GCM/local-hkdf/unsay/local/v1 · AAD=patient|domain|version|audience
  at-rest: AES-256-GCM/local-hkdf/unsay/local/v1 · AAD=patient|domain|version|audience
  GET /verify (no token)    5 chains · 8 versions · intact true · 5/5 sealed at rest
```

The chain and version counts are the plaintext run's, unchanged: encryption seals the value,
it does not add or remove a revision. `test/docs.test.ts` recomputes both counts from the seed
store and fails if either block drifts from the other.

The version hashes are unchanged, because the chain hashes the plaintext — an auditor holding
the log and no key can still replay it.

---

## 4 · A correction survives the network dropping under it

```bash
npm run probe:resume
```

An Echo Show on domestic wifi loses its SSE stream constantly, and a correction that is only
ever *pushed* is a correction that can be silently lost — the failure mode is a 68-year-old
confidently told the old instruction. This subscribes, receives a live revision, drops the
stream the way a proxy timeout does, writes **three** further revisions through the signed
`POST /write` while **nothing is listening**, reconnects with `Last-Event-ID`, and asserts all
three missed notifications are replayed in order.

Three and not one on purpose: a replay that delivered only the LAST missed notification would
pass a single-revision probe and lose the middle of a clinician's correction sequence in the
field.

**Expected:**

```
  subscribed                  care://ray/weight_bearing
  revision A                  v3 · delivered live
  SSE stream dropped          (as a proxy or a domestic wifi blip would)
  revisions B–D               v4–v6 · written with nothing listening

  PASS  revision A delivered on the live stream
  PASS  3 revisions written while the stream was down
  PASS  client reconnected with Last-Event-ID
  PASS  all 3 missed notifications/resources/updated replayed
  PASS  replay arrived on the resumed stream, not the old one
  PASS  chain advanced by exactly 4 versions

  offline window              803 ms
  write → replayed at client  801 ms

  VERDICT: PASS   (6/6 checks)
  receipt → docs/proof/resume.json
```

Exit code 0. Receipt: `docs/proof/resume.json`. The two timings vary run to run — the client's
reconnection delay is pinned at 800 ms so the probe stays quick — but the six checks do not. The
replay is checked against the **server-side** timestamp of the resume request, so a live send
cannot be mistaken for a replay.

---

## 5 · The number

```bash
npm run bench -- --n 200
```

Measures the whole claim, 200 times: the clinician's signed write leaves → HMAC verified →
store → notification → authorized re-read → the client holds the new value.

**Expected:**

<!-- bench:begin — written by `npm run bench`. Do not edit by hand; test/docs.test.ts fails if you do. -->
```
segment                             p50        p95        max
signed write → notification       0.7ms      1.1ms      3.1ms
notification → re-read            0.8ms      2.1ms      4.2ms
─────────────────────────────────────────────────────────────
END-TO-END (write → value)        1.6ms      3.0ms      6.3ms

retraction lands mid-sentence in 200/200 runs (100%)
a host was subscribed for every run: yes
```
<!-- bench:end -->

The milliseconds will differ on your machine and between two runs on this one. That block is
**written by the bench script**, out of the same run that writes `docs/proof/bench.txt` — it is
not transcribed, and `test/docs.test.ts` fails if a line in it is not in the receipt. The last two
lines are the ones that must not change, and the script exits non-zero if either does. The same
run rewrites the three numbers the landing page prints, rounding each **up** to one decimal, so
the page can never quote a figure faster than the run that produced it.

Exit code 0 only if **all 200** land inside the 3,400 ms speech window and a host was actually
subscribed for every one of them. Receipts: `docs/proof/bench.txt`, `docs/proof/bench.json`.

> ⚠️ **Read the note the script prints.** These are loopback figures. A deployed path adds
> network and infrastructure, and the 3,400 ms window is an assumed speech rate, not a
> measurement of Alexa+ text-to-speech. The loopback number is never quoted as a production one.

---

## 6 · The server, and the three surfaces

```bash
npm start
```

One process, one origin: the MCP endpoint, the OAuth metadata, the write path, the public
verification route, and the three pages. It prints links that already carry a minted token:

```
unsay · listening on http://127.0.0.1:39500

  at-rest: PLAINTEXT — no envelope configured (set UNSAY_KEY_PROVIDER=local|kms)
  resource        http://127.0.0.1:39500/mcp
  metadata        http://127.0.0.1:39500/.well-known/oauth-protected-resource
  verify (public) http://127.0.0.1:39500/verify

open these:

  landing         http://127.0.0.1:39500/index.html
  Ray's Echo Show http://127.0.0.1:39500/echo.html?token=…
  clinician       http://127.0.0.1:39500/clinician.html?token=…&key=…
```

Open the Echo Show link and the clinician link side by side, type a new instruction on the
clinician screen and publish it: the device screen strikes through the old line and speaks the
retraction, and the receipt underneath the write reports the round trip it measured.

The Echo Show link carries `care.read.user` **only**. It cannot read a `care-internal://`
record even if it asks.

### The same thing with curl, in a second terminal

```bash
# The door is locked, and it says where to get a key (RFC 9728).
curl -si -X POST localhost:39500/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | head -1
curl -s localhost:39500/.well-known/oauth-protected-resource
```

```
HTTP/1.1 401 Unauthorized
{"resource":"http://127.0.0.1:39500/mcp","authorization_servers":["http://127.0.0.1:39500"],"scopes_supported":["care.read.user","care.read.assistant","care.write"],"bearer_methods_supported":["header"],"resource_documentation":"http://127.0.0.1:39500/verify"}
```

The 401 carries `WWW-Authenticate: Bearer realm="unsay", resource_metadata="…"` — that header is
how a compliant MCP client discovers where to get a token, and it is the reason this is an OAuth
resource server rather than a server with a password.

```bash
# The physio writes. The signature covers the timestamp AND the raw body bytes.
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BODY='{"patient":"ray","domain":"weight_bearing","audience":"user","value":"Full weight-bearing as tolerated.","authorId":"okafor","authorLabel":"Sarah Okafor, physio"}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "dev-only-write-secret-not-for-deployment" -r | cut -d' ' -f1)

curl -s -X POST localhost:39500/write -H 'content-type: application/json' \
  -H "x-unsay-timestamp: $TS" -H "x-unsay-signature: $SIG" -d "$BODY"
```

```
{"uri":"care://ray/weight_bearing","version":3,"versionHash":"6d12c88a…","writtenAt":"…","subscribers":0,"notified":false}
```

`subscribers` is counted, not asserted: with no host attached it is `0` and `notified` is
`false`. Open `echo.html` first and the same write reports `1` and `true`.

```bash
# One byte changed after signing. Same signature, same timestamp.
curl -s -X POST localhost:39500/write -H 'content-type: application/json' \
  -H "x-unsay-timestamp: $TS" -H "x-unsay-signature: $SIG" -d "${BODY/Full/Non-}"
```

```
{"error":"unauthorized"}
```

Uniform, and it names no cause — a bad key and a stale clock are indistinguishable from outside.
The reason it fails at all is that the MAC is verified over the **raw request bytes** before
`JSON.parse`; verifying against a re-serialised parse is how signed webhooks get forged.

```bash
# The public receipt. No token, no account, one link.
curl -s localhost:39500/verify -H 'accept: text/plain'
```

```
unsay · version chain verification
resource : http://127.0.0.1:39500/mcp
checked  : …
at-rest: PLAINTEXT — no envelope configured (set UNSAY_KEY_PROVIDER=local|kms)

INTACT  care://ray/weight_bearing              3 version(s)
INTACT  care://ray/anticoagulant               1 version(s)
INTACT  care://ray/exercise                    1 version(s)
INTACT  care://ray/contact                     1 version(s)
INTACT  care://ray/exercise_clip               1 version(s)

ALL 5 CHAIN(S) INTACT · 7 versions replayed from SHA-256(prev ‖ value ‖ writtenAt ‖ authorId)
0/5 latest version(s) sealed at rest
```

It lists **only** `care://` chains, because a public endpoint that enumerated
`care-internal://` URIs would undo the partition on an open port. Present a token carrying
`care.read.assistant` and the internal chains appear.

---

## The tests

```bash
npm test
npm run typecheck
```

**295 tests**, all passing, across `test/**` (the server, the store, the envelope, the HTTP face,
the retraction wording, and the documents themselves), `web/**` (the three pages — including a run
of `echo.html`'s own hand-rolled MCP client, sliced out of the page and executed against a live
server), and `packages/live-resources/test/**` (the extracted package, imported through its public
entry point only, against a scenario it was not extracted from).

Coverage is deliberately not headlined — two projects in this builder's history shipped 458 and
404 passing tests at 100 % coverage over demos that were broken from a fresh clone. Which is why:

```bash
./scripts/fresh_clone_check.sh
```

clones the repo to a temp directory with **empty state**, installs from scratch, and runs every
command on this page: every `npm` script it names (`bench` at `--n 20` rather than `--n 200`, for time),
the encrypted end-to-end run, a regeneration of `ARCHITECTURE.md` that must leave the file
unchanged, and — against a real `npm start` on a free port — the whole `curl` walkthrough in §6,
asserting the `401`, the metadata body, the signed `"version":3`, the uniform
`{"error":"unauthorized"}` on the tampered body, `ALL 5 CHAIN(S) INTACT`, and that `/verify`
names no `care-internal://` chain. The one line on this page it does not run is
`python3 scripts/check_submission_readiness.py`, which re-runs the suite and the two scripts it
has just run.

The §6 block is why the script exists. Every `npm` script above stands up its own server in
process; §6 is the only part of this page a human types by hand, and until it ran here it was the
only part where drift was invisible. Unit tests never test the sequence a human types, and never
test the absence of state you forgot you had.

```bash
python3 scripts/check_submission_readiness.py
```

Checks the claims in this repository against the repository: that the README's test count matches
the suite, that no command here disables what is being judged, that `npm run verify` and
`npm run e2e` still exit 0, and that `ARCHITECTURE.md` regenerates to the copy that is committed.

`npm test` carries the other half of that: `test/docs.test.ts` asserts the bench table in this
file and in the README is the run that produced `docs/proof/bench.txt`, that every test name
`docs/SPEC.md` cites exists, that no invariant points at a file the code has moved out of, and
that the counts in the documents are the counts.

---

## Other commands

| Command | What it does |
|---|---|
| `npm run seed` | Prints the demo dataset and proves it hashes identically across two seeds |
| `npm run fixtures` | Regenerates the two WAV clips byte-identically from source |
| `npm run keygen` | Prints 32 random bytes of hex for `UNSAY_MASTER_KEY` or `UNSAY_TOKEN_SECRET` |
| `npm run docs:arch` | Regenerates `ARCHITECTURE.md` from the code — nothing in it is hand-written |
| `npm run e2e:browser` | The pages in a real Chromium: every page cold, the two-tab correction, no sideways scroll at 375/768/1440 px. Needs `npx playwright install chromium` once |
| `npm run lighthouse` | Lighthouse on the landing page, `/judge`, the clinician screen and the Echo Show; accessibility below 0.9 fails |

---

## 7 · The two artifacts that exist only because the track is Alexa+

```bash
cat skill/SKILL.md                              # the Agent Skill
npm run e2e | grep -E 'ui://|agent skill'       # the MCP Apps card, over the protocol
```

`skill/SKILL.md` is an **Agent Skill**: the two-rule retraction protocol, the required shape of a
retraction, the never-speak rule, and the `whats_changed` fallback — the same contract the server
sends in its `initialize` result, which `test/server.test.ts` asserts has not drifted.

`ui://unsay/echo` is an **MCP Apps** resource. It is the same 1280×800 Echo Show card
`/echo.html` serves, read out of one file, and delivered *through* the protocol as
`text/html+skybridge` rather than off a static HTTP route. `npm run e2e` reads it over Streamable
HTTP and fails the run if the bytes are not HTML.

What is **not** proven: the `_meta` binding that tells a host to render the `whats_changed` result
into that card. No host we can reach implements the extension, so it is shaped and unexercised —
`FRICTION.md` F-013, and disclosed for the same reason the KMS provider is.

---

## What a judge should look at first

1. `npm run verify` — the safety properties, asserted as failures, including the AAD paste and the
   entrypoint's own clock
2. `packages/live-resources/src/store.ts` `read()` — the enforcement point, ~15 lines.
   `src/store.ts` is the ~115-line adapter that binds it to `care://` URIs
3. `FRICTION.md` F-002 — why the annotation alone could not be the control — and
   **What this build does NOT do**, which is the honest inventory of everything above
4. `docs/proof/live_run.jsonl`, `docs/proof/resume.json` and `docs/proof/verify.json` — the real
   protocol frames and the assertions, as the scripts wrote them
