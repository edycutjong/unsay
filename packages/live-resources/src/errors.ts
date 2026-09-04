/**
 * Every error this package throws descends from LiveResourceError, so a host can
 * tell "the store refused" apart from "something else in my server threw".
 */
export class LiveResourceError extends Error {}

/**
 * A principal asked for a URI it holds no scope for, or for a URI that does not
 * exist. Deliberately the SAME error for both.
 *
 * `code` is JSON-RPC -32002 (MCP "resource not found"), so an MCP server can map
 * it straight onto the wire. Answering "forbidden" instead would confirm that the
 * resource exists, which lets an under-scoped client enumerate the partition it
 * is not allowed to see — the leak is the existence, not the bytes.
 */
export class NotFoundError extends LiveResourceError {
  readonly code = -32002
  constructor(uri: string) {
    super(`Resource not found: ${uri}`)
  }
}

/**
 * A record identity contained the separator used to build the AAD, which would
 * let two distinct records produce the same authenticated-data string and so let
 * sealed bytes be opened in the wrong slot.
 */
export class ReservedSeparatorError extends LiveResourceError {}

/** The partition was configured in a way that does not, in fact, partition. */
export class PartitionConfigError extends LiveResourceError {}
