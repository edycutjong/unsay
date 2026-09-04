/**
 * Blob resource contents — the clips.
 *
 * A care plan is not only sentences. The physio records a short clip demonstrating
 * the movement, and the home visit captures a gait cadence that shapes the advice
 * but must never be played back to the patient.
 *
 * This registry holds BYTES ONLY, keyed by URI. It carries no authorization logic
 * on purpose: `LiveResourceStore.read()` runs first and throws -32002 for a
 * principal without the scope, so the registry is never consulted for a clip the
 * caller may not have. The audience partition therefore covers blobs by
 * construction rather than by a second, drift-prone check.
 */
import { readFileSync } from 'node:fs'

import { uriFor } from './store.ts'
import type { Audience } from './types.ts'

export interface ClipSubject {
  patient: string
  domain: string
  audience: Audience
}

/** Speakable: ten paced tones, one per heel slide. Ray plays it and moves on each. */
export const EXERCISE_CLIP: ClipSubject = {
  patient: 'ray',
  domain: 'exercise_clip',
  audience: 'user',
}

/**
 * Never speakable. The step interval is asymmetric (0.38 s off the operated side,
 * 0.62 s onto it) — a limp, which is exactly the kind of fact that must change the
 * assistant's answer without ever being played to the person it describes.
 */
export const GAIT_NOTE: ClipSubject = {
  patient: 'ray',
  domain: 'gait_note',
  audience: 'assistant',
}

export interface BlobContent {
  mimeType: string
  /** base64 of the fixture, as `BlobResourceContents.blob` requires. */
  base64: string
  description: string
  bytes: number
}

interface BlobSource extends ClipSubject {
  file: string
  mimeType: string
  description: string
}

const SOURCES: BlobSource[] = [
  {
    ...EXERCISE_CLIP,
    file: 'heel-slide-pacer.wav',
    mimeType: 'audio/wav',
    description:
      'Six-second heel-slide pacing clip recorded by Sarah Okafor: ten tones, one per slide.',
  },
  {
    ...GAIT_NOTE,
    file: 'gait-cadence.wav',
    mimeType: 'audio/wav',
    description:
      'Three-second gait cadence from the day-3 home visit. Reasoning context — never play this to the patient.',
  },
]

/** Read once, keep the base64. A clip is a few kB and every read of it needs the same string. */
const cache = new Map<string, BlobContent>()

function load(src: BlobSource): BlobContent {
  const uri = uriFor(src.patient, src.domain, src.audience)
  const hit = cache.get(uri)
  if (hit) return hit
  const bytes = readFileSync(new URL(`../fixtures/${src.file}`, import.meta.url))
  const content: BlobContent = {
    mimeType: src.mimeType,
    base64: bytes.toString('base64'),
    description: src.description,
    bytes: bytes.length,
  }
  cache.set(uri, content)
  return content
}

/** Every clip URI, unversioned. Used by the seed so the registry and the store cannot drift. */
export const CLIPS: ClipSubject[] = SOURCES.map(({ patient, domain, audience }) => ({
  patient,
  domain,
  audience,
}))

/**
 * The blob for a URI, or undefined for a text-only resource. Accepts a versioned
 * URI (`care://ray/exercise_clip/v1`) because the bytes belong to the domain, not
 * to one revision of its description.
 */
export function blobFor(uri: string): BlobContent | undefined {
  const src = SOURCES.find((s) => {
    const base = uriFor(s.patient, s.domain, s.audience)
    return uri === base || uri.startsWith(`${base}/v`)
  })
  return src ? load(src) : undefined
}
