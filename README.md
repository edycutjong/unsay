<div align="center">

# Unsay

**The assistant that can be corrected.**

An MCP server whose resources can be revised mid-sentence — so an assistant can stop,
retract what it just said, and name what changed, who changed it, and how long ago.

</div>

---

> **Ray Dunn is 68, five days home after a hip replacement, and he is about to put his full
> weight on a leg his physio changed the instructions for thirty seconds ago.**

Built for the **Alexa+** track of the Amazon Developer Hackathon (Build, Ship, Shape).

## Status — day 1

🚧 In development. Deadline 2026-10-23.

**Day-1 probe passed** — the correction mechanism is proven, not assumed:

```
server capabilities.resources : {"subscribe":true,"listChanged":true}
notifications/resources/updated RECEIVED
  write → notification        : 0.74 ms   (in-process; real deployment TBD)
  re-read returns new value   : YES
VERDICT: correction lands mid-sentence (< 3400 ms): YES
```

Receipt: [`docs/proof/probe_subscribe.json`](docs/proof/probe_subscribe.json) ·
Reproduce: `npm install && npm run probe`

**Day-2 safety properties pass** — `npm run verify` asserts the reads that MUST fail, do:

```
1. audience partition
  ✓ care-internal://ray/risk unreachable with care.read.user
  ✓ care-internal://ray/adherence unreachable with care.read.user
  ✓ both readable WITH care.read.assistant
2. existence is not leaked
  ✓ list() with user scope returns no care-internal:// URI  — 4 user URIs
  ✓ care:// URI cannot reach an assistant-only record
3. version chain
  ✓ chain intact · ✓ tampering v1 breaks it and is located
4. self-announcing staleness
  ✓ anticoagulant past stale_after (9.0d) · ✓ exercise NOT flagged (1.0d)
5. ✓ publishing an assistant-only record as audience:user is refused

PASS — 0 failing assertion(s)
```

The partition is enforced **server-side by two URI schemes behind two OAuth scopes**, not by
trusting `annotations.audience` — because the spec places no obligation on a client to honour
it. See [`FRICTION.md`](FRICTION.md) F-002.

## Friction log

[`FRICTION.md`](FRICTION.md) — four entries so far, including two proposed changes to the
MCP specification found by building against it.

## Licence

MIT — see [LICENSE](LICENSE).
