# Friction log — Unsay

Every entry written **the day it was hit**, not assembled before submission.
Format per entry: task attempted · steps taken · expected vs actual · severity · workaround ·
actionable suggestion.

Tools covered so far: `@modelcontextprotocol/sdk` (TypeScript), MCP spec 2025-11-25,
Amazon Developer account onboarding.

---

## F-001 · MCP TypeScript SDK · client method name does not match the protocol method

**Date:** 2026-09-02 · **Severity:** Low (30 min) · **Tool:** `@modelcontextprotocol/sdk@1.30.0`

**Task attempted.** Subscribe a client to a resource so it receives `notifications/resources/updated`.

**Steps taken.** Read the 2025-11-25 spec, which names the method `resources/subscribe`. Wrote
`await client.subscribe({ uri })` by analogy with the spec name.

**Expected vs actual.** Expected a `subscribe()` method mirroring the protocol method name.
Got `TypeError: client.subscribe is not a function`. The actual method is **`subscribeResource()`**
(and `unsubscribeResource()`).

**Why it's confusing rather than wrong.** The SDK is internally consistent — `readResource` →
`resources/read`, `listResources` → `resources/list`, so `subscribeResource` → `resources/subscribe`
follows its own verb-noun pattern. But the *spec* is what a developer reads first, and the spec says
`subscribe`. The two vocabularies diverge at exactly the surface that is hardest to discover, because
subscription is the one method with no return value to inspect and no example in the README.

**Workaround.** Grep the `.d.ts`:
`grep -oE '^\s{4}[a-zA-Z]+\(' node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts`

**Actionable suggestion.** Add a one-line subscription example to the TypeScript SDK README — there is
currently none — or export a `subscribe` alias. A single snippet showing
`client.subscribeResource()` + `client.setNotificationHandler(ResourceUpdatedNotificationSchema, …)`
would have saved the lookup entirely.

---

## F-002 · MCP spec 2025-11-25 · `annotations.audience` is advisory, with no enforcement story

**Date:** 2026-09-02 · **Severity:** **High (architectural)** · **Tool:** MCP spec 2025-11-25

**Task attempted.** Use `annotations.audience: ["assistant"]` to hold clinical context that shapes the
model's answer but must **never** be spoken to the patient.

**Expected vs actual.** Expected the spec to state what a client MUST do with `audience`. It defines
the field and its two legal values, and places **no obligation on the client to honour it**. A
compliant client may read an `audience: ["assistant"]` resource and speak it verbatim.

**Why this matters here.** In a healthcare context the difference between "reasoning context" and
"speakable" is a safety boundary, not a presentation hint. `"Fall risk high; family disputes the
discharge plan"` must change the advice and must never reach the patient's ears. **A safety-relevant
annotation a client may ignore is a documentation comment, not a control.**

**Workaround.** Do not rely on the annotation. Unsay splits the graph into two URI schemes
(`care://` and `care-internal://`) behind two OAuth scopes, enforced at the resource server. A client
holding only `care.read.user` receives `-32002` on every internal URI — it is never *sent* the content,
so it cannot leak it. The annotation is retained as a correct-by-convention hint for compliant hosts,
but the enforcement is server-side.

**Actionable suggestion.** Either (a) add normative language — "clients MUST NOT surface content
annotated `audience: ["assistant"]` to end users" — or (b) state explicitly in the spec that `audience`
is a rendering hint with no security properties, so implementers don't mistake it for one. The current
silence invites the second reading of a field that looks like the first. Option (a) would make an
entire class of safety-partitioned MCP servers possible without bespoke authorization.

---

## F-003 · MCP spec 2025-11-25 · no defined client behaviour on `notifications/resources/updated`

**Date:** 2026-09-02 · **Severity:** Medium · **Tool:** MCP spec 2025-11-25

**Task attempted.** Guarantee that a correction written by a clinician reaches the assistant's *speech*
while it is mid-answer.

**Expected vs actual.** Expected the spec to say what a client does on receiving `updated` — re-read,
invalidate, or nothing. It specifies the notification's delivery, not its consequence. A conforming
host may receive the notification and never re-read, in which case the user hears the stale answer to
completion and the correction is invisible.

**Severity reasoning.** This cannot be fixed from the server side. It is the one residual risk in
Unsay's design that no amount of server engineering removes.

**Workaround.** Dual path from commit 1 — native subscription for compliant hosts, plus a
`whats_changed` tool with an `outputSchema`, nudged every turn by the server's `instructions` field.
Both are built and both are exercised in CI, because an unexercised fallback is indistinguishable
from a missing one.

**Actionable suggestion.** A SHOULD-level line — "clients SHOULD re-read a subscribed resource on
`notifications/resources/updated` before using its content in a response" — would be enough. Without
it, "live resources" is a delivery guarantee with no freshness guarantee, and every server author has
to invent the same fallback.

---

## F-004 · Amazon Developer account · payment-verification hold blocks all device tracks

**Date:** 2026-09-01 · **Severity:** **High (blocking, multi-day)** · **Tool:** Amazon account onboarding

**Task attempted.** Register for the Ring Developer Portal to build on the Ring track.

**Steps taken.** Attempted sign-in with an existing Amazon account. Account was under a
payment-verification hold requiring documentary proof of ownership of a card used on a past order.

**Expected vs actual.** Expected developer-console access to be gated on developer identity
verification (which the Ring docs describe: government ID, name matching the Company Profile). Instead
it was gated on **retail** payment verification for an **expired debit card**, with no path visible
from the developer console itself.

**Why the friction is sharper than it looks.** The accepted document types assume a card statement
showing the card number. For an Indonesian **debit** card the bank statement shows the *account*
number, never the card number — so the "preferred" evidence type is structurally impossible to
produce, and the correct route (card photo + alternative statement) is the third option down a list
most users will not read that far into.

**Impact on this hackathon.** Blocks the Ring and Fire TV tracks entirely. Alexa+ is unaffected
because a self-hosted MCP server needs no Amazon credential — which is the only reason this project
was buildable on day 1.

**Actionable suggestion.** When a hold blocks the *developer* console specifically, surface the reason
and the remedy inside the developer console rather than only in retail account settings. And in the
document-type list, mark which options work for **debit** cards — the preferred option silently does
not.

---

*Filed to the submission's product-feedback field, and F-002/F-003 additionally to the MCP
specification repository. Send-by date for upstream filing: **2026-09-20** (see
`../specs/production-plan.md` — a draft with no send date is a loss in progress).*
