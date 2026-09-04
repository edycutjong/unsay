#!/usr/bin/env bash
# Clone this repo to a temp dir with EMPTY state and run DEMO.md from it.
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

run "npm run fixtures"     fixtures

# ARCHITECTURE.md is generated. Regenerating it inside a clean clone and finding the
# file unchanged is the mechanical form of "this document did not drift from the code".
# Everything but the `_Generated:` stamp, which is the current time by definition —
# the same line scripts/check_submission_readiness.py strips before it diffs.
drift() { git --no-pager diff -U0 -- ARCHITECTURE.md | grep -E '^[+-][^+-]' | grep -v '^[+-]_Generated:'; }
printf '  %-34s' "npm run docs:arch (no drift)"
if npm run --silent docs:arch >/tmp/unsay_fc.log 2>&1 && [ -z "$(drift)" ]; then
  echo "PASS"
else
  echo "FAIL"; drift | sed 's/^/      /' | head -10; fail=1
fi

# The encrypted path, end to end. R10: an unexercised seam is a missing feature, and until
# this ran in CI the envelope was proven only by vitest and never by the judged sequence.
printf '  %-34s' "npm run e2e (encrypted at rest)"
if UNSAY_KEY_PROVIDER=local UNSAY_MASTER_KEY="$(npm run --silent keygen)" \
   npm run --silent e2e >/tmp/unsay_fc.log 2>&1 && grep -q "5/5 sealed at rest" /tmp/unsay_fc.log; then
  echo "PASS"
else
  echo "FAIL"; sed 's/^/      /' /tmp/unsay_fc.log | tail -15; fail=1
fi

# The two artifacts §7 asks a judge to look at, over the protocol rather than off disk.
printf '  %-34s' "npm run e2e | ui:// + agent skill"
npm run --silent e2e >/tmp/unsay_fc.log 2>&1 || true
if grep -qE 'ui://unsay/echo' /tmp/unsay_fc.log &&
   grep -q 'agent skill' /tmp/unsay_fc.log &&
   grep -q 'name: unsay-care-plan' skill/SKILL.md; then
  echo "PASS"
else
  echo "FAIL"; fail=1
fi

# ── §6 · npm start, and the curl walkthrough ────────────────────────────────────
#
# This block is the point of the whole script. The npm scripts above all stand up
# their own server in process; §6 is the only part of DEMO.md a JUDGE types by hand,
# and until it ran here it was the one part where drift was invisible (LESSONS R11 —
# a green suite over a sequence nobody runs). It boots the real entrypoint on a free
# port and replays §6 verbatim, asserting each quoted response.
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
PORT="$PORT" npm start >/tmp/unsay_fc_serve.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT

ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.25
done

curl_check() {           # name, expected substring, then the curl arguments
  local name="$1" want="$2"; shift 2
  printf '  %-34s' "$name"
  local got; got="$(curl -s "$@" 2>&1 || true)"
  if printf '%s' "$got" | grep -qF -- "$want"; then
    echo "PASS"
  else
    echo "FAIL"; printf '      wanted %s\n      got    %s\n' "$want" "$(printf '%s' "$got" | head -c 300)"; fail=1
  fi
}

if [ "$ready" -eq 0 ]; then
  printf '  %-34s' "npm start"; echo "FAIL"; sed 's/^/      /' /tmp/unsay_fc_serve.log | tail -15; fail=1
else
  printf '  %-34s' "npm start"; echo "PASS"

  curl_check "curl POST /mcp (no token)" "401 Unauthorized" \
    -si -X POST "localhost:$PORT/mcp" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

  curl_check "curl oauth-protected-resource" '"scopes_supported"' \
    "localhost:$PORT/.well-known/oauth-protected-resource"

  # The physio's signed write, byte for byte the sequence in §6.
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  BODY='{"patient":"ray","domain":"weight_bearing","audience":"user","value":"Full weight-bearing as tolerated.","authorId":"okafor","authorLabel":"Sarah Okafor, physio"}'
  SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "dev-only-write-secret-not-for-deployment" -r | cut -d' ' -f1)"

  curl_check "curl POST /write (signed)" '"version":3' \
    -X POST "localhost:$PORT/write" -H 'content-type: application/json' \
    -H "x-unsay-timestamp: $TS" -H "x-unsay-signature: $SIG" -d "$BODY"

  curl_check "curl POST /write (tampered)" '{"error":"unauthorized"}' \
    -X POST "localhost:$PORT/write" -H 'content-type: application/json' \
    -H "x-unsay-timestamp: $TS" -H "x-unsay-signature: $SIG" -d "${BODY/Full/Non-}"

  curl_check "curl GET /verify (no token)" "ALL 5 CHAIN(S) INTACT" \
    "localhost:$PORT/verify" -H 'accept: text/plain'

  # A public endpoint that enumerated internal chains would undo the partition.
  printf '  %-34s' "GET /verify hides care-internal"
  if curl -s "localhost:$PORT/verify" | grep -q 'care-internal://'; then
    echo "FAIL"; fail=1
  else
    echo "PASS"
  fi

  # The judge-facing surfaces, as a browser gets them — not as a file on disk.
  curl_check "GET /index.html is html" "text/html" -sI "localhost:$PORT/index.html"
  curl_check "GET /doc/readme is rendered" "<h1" "localhost:$PORT/doc/readme"

  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — DEMO.md runs verbatim from an empty state."
else
  echo "FAIL — DEMO.md does not run from a fresh clone. Do not submit."
fi
exit "$fail"
