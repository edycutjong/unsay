# DEMO — reproduce everything in four commands

No flags. No `MOCK=`, no `OFFLINE=1`, no `--dry-run`. If any command below needed a
flag to disable the thing being judged, this submission would be worthless.

**Requirements:** Node ≥ 22 (uses native TypeScript stripping). Nothing else.

```bash
git clone <REPO_URL> && cd unsay
npm install
```

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

## 2 · The safety property holds

```bash
npm run verify
```

This asserts the reads that **must fail**, fail. It is not a happy-path check.

**Expected — 11 assertions, all ✓:**

```
1. audience partition
  ✓ care-internal://ray/risk unreachable with care.read.user
  ✓ care-internal://ray/adherence unreachable with care.read.user
  ✓ both readable WITH care.read.assistant
2. existence is not leaked
  ✓ list() with user scope returns no care-internal:// URI — 4 user URIs
  ✓ care:// URI cannot reach an assistant-only record
3. version chain
  ✓ weight_bearing chain intact (1 versions)
  ✓ tampering v1 breaks the chain and is located — broken at v1
4. self-announcing staleness
  ✓ anticoagulant is past its stale_after — age 9.0d
  ✓ exercise (fresh) is NOT flagged stale — age 1.0d
5. ✓ publishing risk as audience:user is refused

PASS — 0 failing assertion(s)
```

Exit code 0. **If any assertion fails, the clinical-safety claim is false** and the build
should not be submitted.

---

## 3 · The whole demo, as code

```bash
npm run e2e
```

Runs the exact sequence the video shows — capability negotiation, templates,
`completion/complete` resolved through `context.arguments`, Ray's question, the physio's
write landing mid-answer, the retraction, the stale fact announcing its age, and the
fallback tool.

**Expected:**

```
  capabilities.resources    {"subscribe":true,"listChanged":true}
  completion {version}      ["v1"]  ← resolved via context.arguments

  RAY   "Can I put weight on it yet?"
  read  care://ray/weight_bearing
  read  care-internal://ray/risk   ← audience:assistant · NOT SPOKEN

  notifications/resources/updated  <1 ms
  ALEXA "You can put about half your weight on it—"
        "—actually, stop. That changed just now."
        "Sarah Okafor, physio has moved you to full weight-bearing as tolerated."
        "Take it slowly the first time, and have someone nearby."

  stale fact                announces its own age
  fallback whats_changed    1 revision(s) — exercised, not just built

  PASS — receipt → docs/proof/live_run.jsonl
```

Exit code 0. Receipt: `docs/proof/live_run.jsonl` — 12 frames of the real protocol exchange.

---

## 4 · The number

```bash
npm run bench -- --n 200
```

**Expected:** end-to-end p95 well under the 3400 ms speech window, and
`retraction lands mid-sentence in 200/200 runs (100%)`.

Receipts: `docs/proof/bench.txt`, `docs/proof/bench.json`.

> ⚠️ **Read the note the script prints.** These are loopback figures. The deployed path adds
> API Gateway → DynamoDB Streams → Lambda, and those segments are measured separately once
> deployed. The loopback number is not the production number and is never quoted as one.

---

## The tests

```bash
npm test
```

**27 tests**, all passing. Coverage is deliberately not headlined — two projects in this
builder's history shipped 458 and 404 passing tests at 100% coverage over demos that were
broken from a fresh clone. Which is why:

```bash
./scripts/fresh_clone_check.sh
```

clones the repo to a temp directory with **empty state** and runs every command on this page
verbatim. Unit tests never test the sequence a human types.

---

## What a judge should look at first

1. `npm run verify` — the safety property, asserted as failures
2. `src/store.ts` `read()` — the enforcement point, ~15 lines
3. `FRICTION.md` F-002 — why the annotation alone could not be the control
4. `docs/proof/live_run.jsonl` — the real protocol frames
