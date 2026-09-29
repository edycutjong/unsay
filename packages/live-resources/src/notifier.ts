/**
 * The revision notification wiring: store events -> MCP notifications.
 *
 * This is the fiddly half of "resources that change while the model is answering",
 * and it is fiddly for three reasons that every server rediscovers:
 *
 *   1. `notifications/resources/updated` is only legal for a URI the client
 *      actually subscribed to. The subscription set has to live somewhere, and it
 *      has to be per-session, not per-store.
 *   2. `notifications/resources/list_changed` must not fire while the server is
 *      seeding itself. A client that has never called `resources/list` holds no
 *      list to invalidate, so the notification is armed by the first list SERVED
 *      rather than by a timer or a "ready" flag — which makes the quiet window
 *      structural instead of a race against how fast the store fills.
 *   3. A revision written while no host is attached is not an error. The store is
 *      the source of truth and the next read is correct either way, so a send that
 *      fails because nothing is connected must not take the process with it.
 *
 * Nothing is imported from the MCP SDK at runtime — only the two method signatures,
 * as types — so this file adds no dependency to your bundle and still cannot drift
 * from the SDK's `Server`.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { LiveResourceStore } from './store.ts'
import type { Unsubscribe } from './types.ts'

/**
 * The two methods this needs from an MCP server. Typed as a slice of the SDK's
 * `Server`, so a real one satisfies it and a test double is three lines.
 */
export type NotificationTarget = Pick<Server, 'sendResourceUpdated' | 'sendResourceListChanged'>

export interface NotifierOptions {
  store: LiveResourceStore
  target: NotificationTarget
  /**
   * Called for every revision, subscribed or not, before the notification is sent.
   * The hook for a second channel — a log line, a metric, an audit row. It must do
   * its own authorization: naming an internal URI to an under-scoped host would
   * confirm the resource exists, which is what `read()` refuses to do.
   */
  onRevision?: (uri: string) => void
  /**
   * Re-authorization at SEND time, for the URI about to be named. Returning false
   * drops the `updated` notification silently.
   *
   * A subscription is authorized once, when it is created; the principal behind the
   * session can change afterwards. Delivering the URI to a principal that can no
   * longer read it would confirm the resource exists — the one thing a `NotFound`
   * read refuses to confirm. Defaults to "always allowed", which is correct for a
   * server whose principals never narrow.
   */
  canNotify?: (uri: string) => boolean
  /**
   * Failures that are not "nobody is connected". Defaults to `console.error`; pass
   * a no-op to stay silent, never to hide the fact that a host missed a correction.
   */
  onError?: (error: unknown, uri: string | null) => void
}

const NOT_CONNECTED = /not connected/i

export class ResourceNotifier {
  /**
   * The live subscription set, exposed rather than copied: a session-level caller
   * (an HTTP transport counting subscribers per URI) needs to read it, and a copy
   * taken at the wrong moment is a subscriber that silently misses a revision.
   */
  readonly subscriptions = new Set<string>()

  #target: NotificationTarget
  #canNotify: (uri: string) => boolean
  #onError: (error: unknown, uri: string | null) => void
  #offUpdated: Unsubscribe
  #offListChanged: Unsubscribe
  #listServed = false

  constructor(opts: NotifierOptions) {
    this.#target = opts.target
    this.#canNotify = opts.canNotify ?? (() => true)
    this.#onError =
      opts.onError ??
      ((error, uri) => console.error(`[live-resources] notification failed${uri ? ` for ${uri}` : ''}:`, error))

    this.#offUpdated = opts.store.onUpdated((uri) => {
      if (this.subscriptions.has(uri) && this.#canNotify(uri)) {
        this.#send(this.#target.sendResourceUpdated({ uri }), uri)
      }
      opts.onRevision?.(uri)
    })

    // A new chain in a lane this principal cannot read is not a change to ITS list;
    // signalling it would leak that internal content exists (SPEC I-2).
    this.#offListChanged = opts.store.onListChanged((uri) => {
      if (this.#listServed && this.#canNotify(uri)) this.#send(this.#target.sendResourceListChanged(), null)
    })
  }

  #send(sent: Promise<void>, uri: string | null) {
    void sent.catch((e: unknown) => {
      if (NOT_CONNECTED.test(String(e))) return
      this.#onError(e, uri)
    })
  }

  /**
   * Call from your `resources/subscribe` handler AFTER authorizing the URI — this
   * class deliberately cannot authorize anything, because only your read path can.
   */
  subscribe(uri: string) {
    this.subscriptions.add(uri)
  }

  unsubscribe(uri: string) {
    this.subscriptions.delete(uri)
  }

  isSubscribed(uri: string): boolean {
    return this.subscriptions.has(uri)
  }

  /**
   * Call once a `resources/list` response has actually gone out. Until then
   * list_changed is suppressed — see reason 2 in the file header.
   */
  armListChanged() {
    this.#listServed = true
  }

  get listArmed(): boolean {
    return this.#listServed
  }

  /**
   * Detach from the store. A per-session server that closed without this would
   * keep a listener calling into a disconnected transport for the lifetime of the
   * store — the classic long-lived-store, short-lived-session leak.
   */
  dispose() {
    this.#offUpdated()
    this.#offListChanged()
    this.subscriptions.clear()
  }
}
