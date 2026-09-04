# Contributing to Unsay

Unsay is a hackathon build with a deadline (2026-10-23) and a narrow claim: an MCP
resource can be corrected while an assistant is mid-sentence, and the correction is
attributable, auditable and enforced server-side. Contributions that sharpen that
claim are welcome. Contributions that widen it are usually the wrong trade — see
*What this build does NOT do* at the end of [`FRICTION.md`](../FRICTION.md) for the
list of things that are deliberately absent.

## The five constraints

They are unusual enough to be worth stating before you open an editor.

1. **Node ≥ 22, and no build step.** Source is TypeScript, run through native type
   stripping. `tsc --strict` type-checks it; nothing compiles it. That means:
   `.ts` extensions on every relative import, `import type` for anything type-only,
   and no enums, namespaces or decorators — the runtime cannot erase them.
   The trade is argued in `FRICTION.md` F-009.
2. **One runtime dependency.** `@modelcontextprotocol/sdk`, and that is the whole
   list. A PR that adds a second needs to say in its description what it could not
   be done without. The three web pages load no script, stylesheet or font from
   anywhere — `web/web.test.ts` fails if one appears.
3. **Receipts are generated, never edited.** Everything in `docs/proof/` is written
   by a script (`npm run verify`, `e2e`, `probe`, `probe:resume`, `bench`), and the
   blocks those scripts write into `README.md`, `DEMO.md` and `web/index.html` are
   fenced by markers. `test/docs.test.ts` fails if a quoted line is not in the
   receipt that produced it. If a number changes, re-run the script; do not retype
   the number. `docs/proof/initialize.json` is the one hand-written file there, and
   it is hand-written because its status is `not-run`.
4. **`ARCHITECTURE.md` is generated** by `npm run docs:arch` from the handler
   registrations. Edit the code, regenerate, commit both.
5. **Nothing on the judged path may be mockable.** No `MOCK=`, `OFFLINE=1`,
   `--dry-run`, `FAKE=` or `SIMULATE=` reaches any command in `DEMO.md`, and
   `scripts/check_submission_readiness.py` fails if one does.

## Before you open a PR

```bash
npm ci
npm test                 # the suite
npm run typecheck        # tsc --strict
npm run verify           # the reads and writes that MUST fail, do
npm run e2e              # the whole demo, as code, over the real server
npm run probe            # the subscribe → notification handshake, with its receipt
npm run probe:resume     # a correction survives the network dropping under it
./scripts/fresh_clone_check.sh   # DEMO.md, verbatim, from an empty clone
```

Everything above the fresh-clone line is what CI runs on every push. The fresh-clone
check is nightly, because it is the one that catches what a suite cannot: a walkthrough that only works because of state on your machine. Run it
before anything that touches `DEMO.md`, the seed, or the entrypoint.

If you change a safety property — the audience partition, the hash chain, the HMAC
write path, the OAuth scopes — the PR must add the assertion that fails without your
change. `scripts/verify.ts` is where an *external* side effect is asserted; the suite
is where internals are.

## Friction

If a tool cost you time — the MCP spec, the reference SDK, an Amazon console — write
it up in [`FRICTION.md`](../FRICTION.md) **the day you hit it**, in the format the
file already uses: task attempted · steps taken · expected vs actual · severity ·
workaround · actionable suggestion. An entry assembled from memory a week later is a
different, worse document. Number it after the last `F-0NN`; `test/docs.test.ts`
counts the entries and fails if the prose disagrees with the count.

## Voice

Comments say *why*, not what. Commit messages are lowercase, imperative, and name
the thing that changed rather than the file it changed in. Documentation states what
was measured and by which command; if a sentence cannot name the run behind it, it
does not go in.
