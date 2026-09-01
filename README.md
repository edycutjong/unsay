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

## Friction log

[`FRICTION.md`](FRICTION.md) — four entries so far, including two proposed changes to the
MCP specification found by building against it.

## Licence

MIT — see [LICENSE](LICENSE).
