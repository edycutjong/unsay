## What changes, and why

<!-- One paragraph. Name the behaviour that is different, not the files that moved. -->

## The gates

```
npm test
npm run typecheck
npm run verify
npm run e2e
npm run probe:resume
```

- [ ] All five pass locally
- [ ] `./scripts/fresh_clone_check.sh` passes — **required** if this touches `DEMO.md`,
      `src/seed.ts`, `scripts/serve.ts` or anything a stranger's first command reaches
- [ ] `python3 scripts/check_submission_readiness.py` exits 0

## The house rules this repository is written against

- [ ] **No number is transcribed.** If a figure changed, the script that produces it was
      re-run and its receipt in `docs/proof/` is in this diff. Nothing between a
      `bench:begin` / `e2e:begin` marker pair was typed by hand.
- [ ] **No new dependency**, or the description says what this could not be done without.
- [ ] **Node 22 type stripping respected**: `.ts` on relative imports, `import type` for
      type-only imports, no enums, namespaces or decorators.
- [ ] **A changed safety property comes with the assertion that fails without it** — in
      `scripts/verify.ts` for an external side effect, in the suite for an internal one.
- [ ] **`ARCHITECTURE.md` regenerated** (`npm run docs:arch`) if a handler was added,
      removed or renamed.
- [ ] **Nothing is claimed that has not run.** If this adds a capability that has not been
      exercised end to end, it is disclosed in *What this build does NOT do* in
      `FRICTION.md` rather than described as working.

## Friction

<!-- Did a tool cost you time on the way? Add the entry to FRICTION.md in this PR, while
     you still remember what you expected. An entry written from memory next week is a
     different, worse document. -->
