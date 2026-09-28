# For judges — Unsay in thirty seconds

**An MCP server whose resources can be revised mid-sentence — so an assistant can stop, retract
what it just said, and name what changed, who changed it, and how long ago.**

No account, no clone, no key. Everything on this page is live at
[api.unsay.edycu.dev/judge](https://api.unsay.edycu.dev/judge) and answers without a token.

---

## The thirty-second path

1. Open the landing page, [api.unsay.edycu.dev/](https://api.unsay.edycu.dev/). It mints its own demo tokens; you do
   not need one.
2. From it, open **The Echo Show screen** and **The clinician write screen** side by side.
3. On the clinician screen, type a new weight-bearing instruction and publish it.
4. Watch the Echo Show: the line it was speaking strikes through, the new one replaces it, and the
   provenance line names the physio and how long ago the change was made.
5. Open [api.unsay.edycu.dev/verify](https://api.unsay.edycu.dev/verify) — the public receipt. Every resource's version chain,
   its hash, and whether it is intact, with no token.

Nothing there is a recording. The deployment is one in-memory process, so a revision you publish
is real for everyone until the next restart resets it to the seed.

## The receipts

| What | Number | Where it was written |
|---|---|---|
| Retraction lands inside the speech window, over the public internet | **200/200**, end-to-end p95 **461 ms** | [`docs/proof/bench.remote.txt`](docs/proof/bench.remote.txt) |
| Safety assertions that MUST fail, and do | **34/34** (15 in-process, 19 over HTTP) | [`docs/proof/verify.json`](docs/proof/verify.json) |
| Test suite | **301 passing**, `tsc --strict` clean | `npm test` · `npm run typecheck` |
| Real protocol frames of the whole demo | one JSONL line per frame | [`docs/proof/live_run.jsonl`](docs/proof/live_run.jsonl) |
| A correction survives the connection dropping under it | resumed with `Last-Event-ID` | [`docs/proof/resume.json`](docs/proof/resume.json) |

The 3,400 ms speech window is an assumed speech rate, not a measurement of Alexa+ TTS, and the
bench says so on every run.

## Reproduce it

The real path, against the real server, with no flags:

```bash
git clone https://github.com/edycutjong/unsay.git && cd unsay
npm install
npm run verify     # the reads and writes that MUST fail, do
npm run e2e        # the whole demo, as code, over Streamable HTTP
npm run bench -- --n 200 --url https://api.unsay.edycu.dev
```

There is no offline mode to confuse with the product. `npm test` needs no credentials because
nothing Unsay does needs one — the server it tests is the server that is deployed.

## Where to look first

1. `packages/live-resources/src/store.ts` `read()` — the enforcement point. The audience split is
   two URI schemes behind two OAuth scopes, enforced here, not trusted to the host.
2. [`FRICTION.md`](FRICTION.md) F-002 — why `annotations.audience` alone could not be the control.
3. [`DEMO.md`](DEMO.md) — every command above, verbatim from an empty clone, and what each proves.

## Honest limitations

- **Alexa+ itself has not been reached.** Whether it declares `capabilities.resources.subscribe`
  and re-reads on `notifications/resources/updated` is unanswered. That is why the `whats_changed`
  fallback tool is built and exercised by `npm run e2e`, not merely described.
- **The AWS KMS provider has never run against a live key.** It is SigV4-signed by hand and
  shaped; the deployment runs plaintext at rest and `/verify` says so out loud.
- **No video yet, and no external users.** The deployment's clinician screen carries this
  repository's published dev write key on purpose, so you can fire a revision yourself; the
  patient is fictional.

## Links

- Landing page and pitch deck: [unsay.edycu.dev](https://unsay.edycu.dev/) · [unsay.edycu.dev/pitch](https://unsay.edycu.dev/pitch/)
- Live: [api.unsay.edycu.dev/](https://api.unsay.edycu.dev/)
- Public receipt: [api.unsay.edycu.dev/verify](https://api.unsay.edycu.dev/verify)
- Repository: [github.com/edycutjong/unsay](https://github.com/edycutjong/unsay)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md) · Spec & threat model: [`docs/SPEC.md`](docs/SPEC.md)
