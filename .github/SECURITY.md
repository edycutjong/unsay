# Security policy

Unsay carries clinical instructions to a patient's speaker. Two of its failure modes
are worse than a crash: a patient hearing an instruction that has been superseded, and
a patient hearing something written for the assistant's reasoning and never meant to
be spoken. Both are treated as security bugs here, not as product bugs.

## What is in scope

A report is in scope if it breaks one of the properties `npm run verify` asserts:

- **The audience partition.** Any way for a principal holding only `care.read.user` to
  reach a `care-internal://` record, or to learn that one exists — through
  `resources/list` on any cursor page, a notification, the revision log, a
  `Last-Event-ID` resume, `GET /verify`, or an error message that distinguishes
  "forbidden" from "not found".
- **The hash chain.** Any way to alter a past revision, or to publish one whose
  `prevHash` does not descend from what a host was told, without
  `npm run verify` locating the break.
- **The write path.** Any way to get `POST /write` to accept a body that was not
  HMAC-signed with the configured key over the raw bytes and a fresh timestamp —
  replay, signature stripping, a parse-then-verify ordering bug.
- **Tokens and scopes.** Forging or widening a bearer token, or reaching a resource
  outside the `aud` it was minted for.
- **Encryption at rest.** Any way to decrypt a record moved between patients,
  domains, versions or audiences — the AAD binding in `src/envelope.ts`.
- **Anything that makes a stale instruction look current**, including suppressing a
  staleness header or an age.

## What is not in scope

- The dev-mode credentials. `DEV_WRITE_SECRET` and `DEV_TOKEN_SECRET` are literals in
  `src/http.ts`, they are meant to be, the server prints a warning at startup for every
  default it fell back to, and `.env.example` names the real variables. Reporting them
  as leaked keys is not a finding. Shipping a deployment that keeps them is.
- The latency figures. They are loopback, and every place they appear says so.
- The absence of an authorization server. Unsay is an OAuth **protected resource**
  only, deliberately; it serves no `/authorize`, `/token` or JWKS endpoint.
- Anything requiring an attacker who already holds the write key or the token secret.

## How to report

Use GitHub's **private vulnerability reporting** on this repository: the *Security*
tab → *Report a vulnerability*. It is private to the maintainers and needs no prior
contact.

If that route is not visible to you, open an issue containing nothing but the words
`security contact` and no detail at all, and wait to be reached. Do not put the finding
in a public issue, a PR description, or a comment.

**Do not include real patient data in a report** — not your own, not anyone else's.
Every property above can be demonstrated against the fictional seed in `src/seed.ts`,
and a report that needs real health information to make its point is a report that has
gone wrong. If a finding somehow requires real data, say so and stop; do not attach it.

## What you can expect

This is a hackathon project with one maintainer and a public deadline, and pretending
otherwise would be its own kind of dishonesty:

- Acknowledged within **72 hours**.
- An assessment — in scope, out of scope, or already disclosed — within **7 days**.
- A fix or a written decision not to fix, with the reasoning, before the report is
  closed. If a finding cannot be fixed before the deadline, it is added to *What this
  build does NOT do* in [`FRICTION.md`](../FRICTION.md) rather than left unsaid.
- Credit in the commit and the release notes, unless you ask otherwise.
- No bounty. There is no money in this project.

## Supported versions

`main` only. Nothing has been released or published to npm, and there is no deployed
instance to compromise: `npm start` runs on the reader's own machine. The threat model
this policy is written against is a **downstream** deployment of this code, and it is
written out in full in [`docs/SPEC.md`](../docs/SPEC.md).

## Not a medical device

Unsay relays what a clinician wrote. It does not generate clinical guidance, does not
decide anything, and is not a medical device. A safety concern about the *content* of
an instruction belongs with the clinician who wrote it; a safety concern about the
*delivery* of that instruction belongs here.
