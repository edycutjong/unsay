#!/usr/bin/env bash
# Clone this repo to a temp dir with EMPTY state and run DEMO.md verbatim.
#
# LESSONS R11: two sibling projects shipped 458 and 404 passing tests at 100%
# coverage, and both had a DEMO.md "money shot" that failed from a fresh clone —
# one silently required 15 prior commands, the other had fixtures generated
# against older code. Unit tests never test the sequence a human types, and never
# test the absence of state you forgot you had.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "fresh-clone check"
echo "  source : $REPO_ROOT"
echo "  target : $TMP/unsay"
echo

git clone --quiet "$REPO_ROOT" "$TMP/unsay"
cd "$TMP/unsay"

# Prove we are testing a CLEAN checkout, not the working tree.
if [ -d node_modules ]; then echo "FAIL: node_modules came from the clone"; exit 1; fi
if [ -f docs/proof/bench.txt ]; then
  echo "  note: committed receipts present (expected — they are evidence, not state)"
fi

echo "  npm install …"
npm install --silent >/dev/null 2>&1

fail=0
run() {
  printf '  %-34s' "$1"
  if npm run --silent "$2" -- "${@:3}" >/tmp/unsay_fc.log 2>&1; then
    echo "PASS"
  else
    echo "FAIL"
    sed 's/^/      /' /tmp/unsay_fc.log | tail -15
    fail=1
  fi
}

# The suite runs FIRST, on the receipts exactly as they were committed. web/web.test.ts
# gates the landing page's headline figures against docs/proof/bench.json, and `npm run
# bench` below rewrites that file — running the suite afterwards would compare the page
# against numbers it could not have been written from, and fail for the wrong reason.
printf '  %-34s' "npm test"
if npx vitest run >/tmp/unsay_fc.log 2>&1; then echo "PASS"; else echo "FAIL"; sed 's/^/      /' /tmp/unsay_fc.log | tail -15; fail=1; fi

printf '  %-34s' "npm run typecheck"
if npx tsc --noEmit >/tmp/unsay_fc.log 2>&1; then echo "PASS"; else echo "FAIL"; sed 's/^/      /' /tmp/unsay_fc.log | tail -15; fail=1; fi

run "npm run seed"         seed
run "npm run probe"        probe
run "npm run verify"       verify
run "npm run e2e"          e2e
run "npm run probe:resume" probe:resume
run "npm run bench -- --n 20" bench --n 20

# The encrypted path, end to end. R10: an unexercised seam is a missing feature, and until
# this ran in CI the envelope was proven only by vitest and never by the judged sequence.
printf '  %-34s' "npm run e2e (encrypted at rest)"
if UNSAY_KEY_PROVIDER=local UNSAY_MASTER_KEY="$(npm run --silent keygen)" \
   npm run --silent e2e >/tmp/unsay_fc.log 2>&1 && grep -q "5/5 sealed at rest" /tmp/unsay_fc.log; then
  echo "PASS"
else
  echo "FAIL"; sed 's/^/      /' /tmp/unsay_fc.log | tail -15; fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — DEMO.md runs verbatim from an empty state."
else
  echo "FAIL — DEMO.md does not run from a fresh clone. Do not submit."
fi
exit "$fail"
