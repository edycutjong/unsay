# DEMO — reproduce everything from an empty clone

No flags. No `MOCK=`, no `OFFLINE=1`, no `--dry-run`. If any command below needed a flag to
disable the thing being judged, this submission would be worthless.

**Requirements:** Node ≥ 22 (uses native TypeScript stripping) and `curl`. Nothing else — no
build step, no database, no cloud account, one runtime dependency.

```bash
git clone <REPO_URL> && cd unsay
npm install
```

Everything below runs against that clone with no further setup. Five commands prove the
product; the sixth opens it in a browser.

---

## 1 · The correction mechanism is real

```bash
npm run probe
```

Stands up an MCP server and a spec-compliant client over **Streamable HTTP**, subscribes,
revises a resource, and measures how long the notification takes to arrive.

**Expected:**

```
  server capabilities.resources : {"subscribe":true,"listChanged":true}
  subscribe supported           : YES
  notifications/resources/updated RECEIVED
    write → notification        : <1 ms
    re-read returns new value   : YES
  VERDICT: correction lands mid-sentence (< 3400 ms): YES
```

Exit code 0. Receipt: `docs/proof/probe_subscribe.json`.

---

## 2 · The safety properties hold

```bash
npm run verify
```

This asserts the reads that **must fail**, fail. It is not a happy-path check. Sections 1–5 run
in process; sections 6–8 stand up a real HTTP server and attack it.

**Expected — 29 assertions, all ✓:**

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
  ✓ anticoagulant is past its stale_after — stale_after 2026-10-04T00:00:00Z, age 9.0d
  ✓ exercise (fresh) is NOT flagged stale — age 1.0d

5. audience cannot be changed by a later write
  ✓ publishing risk as audience:user is refused

6. OAuth scope boundary over HTTP
  ✓ POST /mcp with no token is refused — HTTP 401
  ✓ a token with an escalated scope claim is refused — HTTP 401
  ✓ care-internal://ray/risk unreachable over HTTP with care.read.user
  ✓ resources/list over HTTP returns no care-internal:// URI, on any page — 5 user URIs over every cursor page
  ✓ care-internal://ray/risk readable over HTTP with care.read.assistant
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

PASS — 0 failing assertion(s)
```

Exit code 0. **If any assertion fails, the clinical-safety claim is false** and the build should
not be submitted.

Section 7 is the one worth pausing on: it pastes the ciphertext of `care-internal://ray/risk`
into `care://ray/weight_bearing`, which is what an attacker who owns the database does and what
no scope check can see. The AES-256-GCM AAD binds every record to
`patient|domain|version|audience`, so the bytes refuse to decrypt in the wrong slot.

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

```
unsay · end-to-end · the demo as code

  at-rest: PLAINTEXT — no envelope configured (set UNSAY_KEY_PROVIDER=local|kms)
  no token                  HTTP 401 · Bearer realm="unsay"

  capabilities.resources    {"subscribe":true,"listChanged":true}
  completions · prompts     declared · declared
  logging                   declared
  instructions              present

  templates                 care://{patient}/{domain}/{version}, care-internal://{patient}/{domain}/{version}
  resources/list            8 resources over 3 cursor page(s)
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
  notifications/resources/updated  1.40 ms
  ALEXA "You can put about half your weight on it—"
        "—actually, stop. That changed just now."
        "Sarah Okafor, physio has moved you to full weight-bearing as tolerated."
        "Take it slowly the first time, and have someone nearby."   ← from care-internal://ray/risk, reason never spoken
  v3.prevHash === v2.versionHash  YES — the retraction is auditable

  stale fact                announces its own age
        [STALE — last changed 9 days ago by Dr Mensah, GP; say this age aloud]
  prompts/get brief_carer   speakable only · 873 chars
  fallback whats_changed    1 revision(s) — exercised, not just built

  GET /verify (no token)    5 chains · 7 versions · intact true · 0/5 sealed at rest

  PASS — receipt → docs/proof/live_run.jsonl (18 frames)
```

Exit code 0. Receipt: `docs/proof/live_run.jsonl` — 18 frames of the real protocol exchange plus
a summary line. The `1.40 ms` will differ on your machine; nothing else should.

**The same run, encrypted at rest:**

```bash
UNSAY_KEY_PROVIDER=local UNSAY_MASTER_KEY=$(npm run --silent keygen) npm run e2e
```

Identical output except the two at-rest lines:

```
  at-rest: AES-256-GCM/local-hkdf/unsay/local/v1 · AAD=patient|domain|version|audience
  GET /verify (no token)    5 chains · 7 versions · intact true · 5/5 sealed at rest
```

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
stream the way a proxy timeout does, writes a second revision through the signed `POST /write`
while **nothing is listening**, reconnects with `Last-Event-ID`, and asserts the missed
notification is replayed.

**Expected:**

```
  subscribed                  care://ray/weight_bearing
  revision A                  v3 · delivered live
  SSE stream dropped          (as a proxy or a domestic wifi blip would)
  revision B                  v4 · written with nothing listening

  PASS  revision A delivered on the live stream
  PASS  revision B written while the stream was down
  PASS  client reconnected with Last-Event-ID
  PASS  missed notifications/resources/updated replayed
  PASS  replay arrived on the resumed stream, not the old one
  PASS  chain advanced by exactly two versions

  offline window              804 ms
  write → replayed at client  805 ms

  VERDICT: PASS
```

Exit code 0. Receipt: `docs/proof/resume.json`. The replay is checked against the **server-side**
timestamp of the resume request, so a live send cannot be mistaken for a replay.

---

## 5 · The number

```bash
npm run bench -- --n 200
```

Measures the whole claim, 200 times: the clinician's signed write leaves → HMAC verified →
store → notification → authorized re-read → the client holds the new value.

**Expected:**

```
segment                             p50        p95        max
signed write → notification       0.8ms      2.0ms      3.7ms
notification → re-read            0.9ms      1.8ms      3.7ms
─────────────────────────────────────────────────────────────
END-TO-END (write → value)        1.7ms      3.3ms      7.2ms

retraction lands mid-sentence in 200/200 runs (100%)
a host was subscribed for every run: yes
```

The figures will differ on your machine. `npm run bench` also rewrites the three numbers the
landing page prints, rounding each **up** to one decimal — so the page can never quote a figure
faster than the run that produced it, and `web/web.test.ts` fails if anyone edits one by hand.

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

**156 tests**, all passing, across `test/**` (the server, the store, the envelope, the HTTP face)
and `web/**` (the three pages). Coverage is deliberately not headlined — two projects in this
builder's history shipped 458 and 404 passing tests at 100 % coverage over demos that were broken
from a fresh clone. Which is why:

```bash
./scripts/fresh_clone_check.sh
```

clones the repo to a temp directory with **empty state**, installs from scratch, and runs every
command on this page verbatim. Unit tests never test the sequence a human types, and never test
the absence of state you forgot you had.

```bash
python3 scripts/check_submission_readiness.py
```

Checks the claims in this repository against the repository: that the README's test count matches
the suite, that no command here disables what is being judged, that `npm run verify` and
`npm run e2e` still exit 0.

---

## Other commands

| Command | What it does |
|---|---|
| `npm run seed` | Prints the demo dataset and proves it hashes identically across two seeds |
| `npm run fixtures` | Regenerates the two WAV clips byte-identically from source |
| `npm run keygen` | Prints 32 random bytes of hex for `UNSAY_MASTER_KEY` or `UNSAY_TOKEN_SECRET` |
| `npm run docs:arch` | Regenerates `ARCHITECTURE.md` from the code — nothing in it is hand-written |

---

## What a judge should look at first

1. `npm run verify` — the safety properties, asserted as failures, including the AAD paste
2. `src/store.ts` `read()` — the enforcement point, ~15 lines
3. `FRICTION.md` F-002 — why the annotation alone could not be the control — and
   **What this build does NOT do**, which is the honest inventory of everything above
4. `docs/proof/live_run.jsonl` and `docs/proof/resume.json` — the real protocol frames
