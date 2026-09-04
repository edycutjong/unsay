# @unsay/live-resources

Versioned, notifying, audience-partitioned resources for MCP servers whose state
changes while the model is answering.

> Not published to npm. It is developed inside the [Unsay](../../) repository and
> consumed from source. See [Installing](#installing).

## The problem

An MCP server that publishes anything mutable has a race it usually loses.

A host reads `resources/read`, starts generating an answer, and three seconds later
the underlying fact changes. The sentence already leaving the speaker is now wrong,
and the server has no way to say so. Most servers answer this by returning a
snapshot and hoping — which is fine for a file, and not fine for a deployment
status, an on-call rotation, an inventory count, a price, or a clinical
instruction.

MCP has the machinery to fix it: `resources/subscribe`,
`notifications/resources/updated`, `notifications/resources/list_changed`, and
`annotations`. Wiring them correctly is where the time goes, and there are four
traps in the way:

1. **`updated` is only legal for URIs a client actually subscribed to.** So the
   subscription set has to be per-session, not per-store, and it has to be
   authorized before anything is added to it.
2. **`list_changed` must stay quiet while the server seeds itself.** A client that
   has never called `resources/list` holds no list to invalidate; firing anyway
   makes every host re-list at boot.
3. **"the plan changed" is worthless if it cannot be checked.** A client that heard
   v2 and now hears v3 should be able to prove v3 descends from the exact v2 it
   read, and an auditor should be able to replay the whole thing without trusting
   the server.
4. **`annotations.audience` is a hint, not a fence.** The specification places no
   obligation on a client to honour it, so a server that keeps
   assistant-only content behind an annotation is one careless host away from
   reading it out loud.

This package is those four things, and nothing else. It has no runtime
dependencies, no storage opinion, and no idea what your resources are about.

## Installing

There is no npm release. Vendor it as a workspace package or copy `src/` in:

```jsonc
// package.json
{ "workspaces": ["packages/*"] }
```

It ships TypeScript source, which Node 22 runs directly (`--experimental-strip-types`)
as long as the files are in your own tree — Node does **not** strip types inside
`node_modules`, so if you install it as a real dependency, transpile it first.

`@modelcontextprotocol/sdk` is an **optional peer dependency**: it is used only for
the two method signatures in `ResourceNotifier`, and nothing is imported from it at
runtime.

## Twenty lines

```ts
import { AudiencePartition, LiveResourceStore, ResourceNotifier } from '@unsay/live-resources'

const partition = new AudiencePartition({
  user: { scheme: 'deploy://', scope: 'deploy.read.user' },        // may be shown or spoken
  assistant: { scheme: 'deploy-internal://', scope: 'deploy.read.assistant' }, // may only be reasoned over
})
const store = new LiveResourceStore({ partition })
const notifier = new ResourceNotifier({ store, target: server }) // an MCP SDK Server

store.publish({
  subject: 'api', topic: 'rollout', audience: 'user', value: 'Canary at 5%.',
  authorId: 'ci', authorLabel: 'the deploy bot', writtenAt: new Date().toISOString(),
})

server.setRequestHandler(SubscribeRequestSchema, async (req) => {
  store.read(req.params.uri, principal())   // authorize first — throws NotFoundError (code -32002)
  notifier.subscribe(req.params.uri)        // now the host gets every later revision
  return {}
})

// Rolled back at 02:14. The host is mid-answer; publish() notifies it before it finishes.
store.publish({ subject: 'api', topic: 'rollout', audience: 'user', value: 'Rolled back.', /* … */ })
```

A principal holding only `deploy.read.user` cannot read — or even discover the
existence of — anything under `deploy-internal://`. It gets the same "not found" it
would get for a URI that never existed.

## API

### `new LiveResourceStore({ partition?, codec? })`

In-memory, append-only. Persistence goes behind it (rehydrate by replaying
`publish`) or beside it (mirror `onUpdated`).

| Method | Does |
|---|---|
| `publish(input)` | Appends a revision, links its hash, fires `updated` (or `listChanged` for a first appearance). Returns the stored record. |
| `read(uri, principal)` | The enforcement point. Throws `NotFoundError` when the principal lacks the scope, when the URI is malformed, and when it simply does not exist — deliberately indistinguishable. |
| `list(principal)` | `{ record, uri }` for the newest revision of everything this principal may know exists. |
| `versions(subject, topic)` | The whole chain, oldest first. Unauthorized — gate it with `read()`. |
| `staleness(uri, principal, now?)` | `{ ageMs, stale, lastModified, versionHash, staleAfter }`. |
| `verify(subject, topic)` | Replays the chain. Returns `{ intact }`, or `{ intact: false, brokenAt, expected, actual }`. |
| `annotationsFor(record)` | `{ audience, priority, lastModified }`, ready for an MCP resource entry. |
| `atRest(subject, topic, version?)` | The stored bytes — ciphertext with a codec, plaintext without. |
| `atRestReceipt(…)` | What those bytes say about themselves: algorithm, provider, key id, IV, tag, size, AAD. Never needs the key. |
| `onUpdated(fn)` / `onListChanged(fn)` | Subscribe; each returns its own unsubscribe. |
| `uriFor(subject, topic, audience, version?)` | Delegates to the partition. |

`publish` refuses to change the audience of an existing resource: subscribers hold
the old URI, and a silent flip would serve them the other lane's content.

### `new AudiencePartition({ user, assistant })`

Each audience gets a URI scheme and an OAuth scope. Throws at construction if the
two lanes share either — that configuration does not partition anything.
`uriFor()`, `parseUri()`, `schemeFor()`, `scopeFor()`. `DEFAULT_PARTITION` uses
`live://` / `live-internal://` for a first server.

### `new ResourceNotifier({ store, target, onRevision?, onError? })`

Owns the subscription set for one session and turns store events into MCP
notifications. `subscribe(uri)` (authorize first — this class cannot), `unsubscribe`,
`isSubscribed`, `subscriptions`, `armListChanged()` once a list has actually been
served, and `dispose()` when the session ends. A send that fails because nothing is
connected is ignored; every other failure reaches `onError`.

`target` is any object with `sendResourceUpdated` and `sendResourceListChanged` —
the MCP SDK's `Server` satisfies it, and so does a three-line test double.

### `hashVersion(prev, value, writtenAt, authorId)` · `recordAad(identity)`

The chain: `SHA-256(prev ‖ JSON(value) ‖ writtenAt ‖ authorId)`. The author is in
the hash because two people writing identical text are two different events.

`recordAad` builds `subject|topic|v<n>|audience` — the string a codec binds
ciphertext to. `|` is reserved so two identities cannot collide into one AAD.

### `ValueCodec`

The encryption seam, so this package needs no crypto of its own:

```ts
interface ValueCodec {
  readonly name: string
  seal(plaintext: string, aad: string): string
  open(sealed: string, aad: string): string
  describe?(sealed: string): SealedDescription | null
}
```

Supply one and values are sealed at rest, bound by `recordAad` to the exact slot
they belong in. That is what makes the partition survive an attacker with *write*
access to your storage: moving an internal record's bytes into a user-readable slot
no longer makes them readable — they fail to authenticate, and `verify()` reports
the chain broken at that version. The hash chain always covers the **plaintext**, so
encryption at rest changes nothing an auditor can check.

## Tests

`test/live-resources.test.ts` imports the public entry point and nothing else, and
runs against a scenario the package was not extracted from. From the repository
root: `npx vitest run packages/live-resources`.

## License

MIT © Edy Tjong
