/**
 * The audience/scope partition.
 *
 * MCP lets a server annotate a resource with `annotations.audience`, but places no
 * obligation on a client to honour it. So annotation alone cannot be a safety
 * boundary: a non-compliant or merely careless host will read `assistant`-only
 * content straight out to the person it was written about.
 *
 * This makes the audience STRUCTURAL instead. Each audience gets its own URI
 * scheme and its own OAuth scope, both decided server-side from the record. A
 * client that ignores annotations still cannot reach the other lane, because it is
 * never handed a URI in a scheme it holds no scope for, and a read of one it
 * guessed is answered "not found".
 *
 * The annotation stays — hosts that do honour it get the hint — but it is the
 * hint, not the fence.
 */
import { PartitionConfigError } from './errors.ts'
import type { Audience } from './types.ts'

/** One side of the partition: the URI scheme it lives under, the scope that opens it. */
export interface AudienceLane {
  /** Include the separator, e.g. `docs://`. */
  scheme: string
  scope: string
}

export interface PartitionConfig {
  user: AudienceLane
  assistant: AudienceLane
}

export interface ParsedUri {
  subject: string
  topic: string
  audience: Audience
  /** Absent for the unversioned form, which always means "the newest revision". */
  version?: number
}

export const AUDIENCES: readonly Audience[] = ['user', 'assistant']

export class AudiencePartition {
  readonly lanes: PartitionConfig
  /** Longest scheme first, so a scheme that prefixes another cannot shadow it. */
  readonly #ordered: { audience: Audience; scheme: string }[]

  constructor(lanes: PartitionConfig) {
    for (const audience of AUDIENCES) {
      const lane = lanes[audience]
      if (!lane?.scheme || !lane.scope) {
        throw new PartitionConfigError(`audience "${audience}" needs both a scheme and a scope`)
      }
      if (!lane.scheme.endsWith('://')) {
        throw new PartitionConfigError(`scheme "${lane.scheme}" must end with "://"`)
      }
    }
    if (lanes.user.scheme === lanes.assistant.scheme) {
      throw new PartitionConfigError(`both audiences use the scheme "${lanes.user.scheme}"`)
    }
    if (lanes.user.scope === lanes.assistant.scope) {
      // One scope for both lanes is not a partition — every holder of it reads
      // everything. Refuse at construction rather than leak at read time.
      throw new PartitionConfigError(`both audiences use the scope "${lanes.user.scope}"`)
    }
    this.lanes = lanes
    this.#ordered = AUDIENCES.map((audience) => ({ audience, scheme: lanes[audience].scheme })).sort(
      (a, b) => b.scheme.length - a.scheme.length,
    )
  }

  schemeFor(audience: Audience): string {
    return this.lanes[audience].scheme
  }

  scopeFor(audience: Audience): string {
    return this.lanes[audience].scope
  }

  /** `<scheme><subject>/<topic>`, plus `/v<n>` when a version is named. */
  uriFor(subject: string, topic: string, audience: Audience, version?: number): string {
    const base = `${this.schemeFor(audience)}${subject}/${topic}`
    return version === undefined ? base : `${base}/v${version}`
  }

  /** null for anything this partition did not issue — an unknown scheme, a short
   * path, or a version segment that is not `v<digits>`. Never throws: a malformed
   * URI is a client mistake, and callers turn it into "not found". */
  parseUri(uri: string): ParsedUri | null {
    for (const { audience, scheme } of this.#ordered) {
      if (!uri.startsWith(scheme)) continue
      const parts = uri.slice(scheme.length).split('/').filter(Boolean)
      if (parts.length < 2 || parts.length > 3) return null
      const [subject, topic, versionPart] = parts
      let version: number | undefined
      if (versionPart !== undefined) {
        const m = /^v(\d+)$/.exec(versionPart)
        if (!m) return null
        version = Number(m[1])
      }
      return { subject: subject!, topic: topic!, audience, version }
    }
    return null
  }
}

/**
 * A partition for servers that have no scheme of their own yet. Real deployments
 * should name their own — the scheme is what a host sees, and `live://` says
 * nothing about whose data it is.
 */
export const DEFAULT_PARTITION = new AudiencePartition({
  user: { scheme: 'live://', scope: 'live.read.user' },
  assistant: { scheme: 'live-internal://', scope: 'live.read.assistant' },
})
