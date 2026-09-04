/**
 * Regenerates the committed audio fixtures. Pure arithmetic, no randomness, so a
 * regenerated file is byte-identical to the committed one — the blob resources a
 * judge reads are reproducible from source, not opaque binaries.
 *
 * Run: node --experimental-strip-types fixtures/gen.ts
 *
 * Format is 4 kHz 8-bit mono PCM: the smallest encoding that is still a real,
 * playable WAV (24 kB for six seconds), because these files are committed and
 * base64-inlined into every resources/read of a clip URI.
 */
import { writeFileSync } from 'node:fs'

const RATE = 4000
const SILENCE = 128

/** 44-byte canonical PCM header + unsigned 8-bit samples. */
function wav(samples: Uint8Array): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(1, 20) // audioFormat = PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE, 28) // byteRate = rate * channels * bytesPerSample
  header.writeUInt16LE(1, 32) // blockAlign
  header.writeUInt16LE(8, 34) // bitsPerSample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, Buffer.from(samples)])
}

/** One tone burst with a 5 ms raised-cosine ramp at each end, so it does not click. */
function burst(buf: Uint8Array, startSec: number, durSec: number, hz: number, amp: number) {
  const start = Math.round(startSec * RATE)
  const len = Math.round(durSec * RATE)
  const ramp = Math.min(Math.round(0.005 * RATE), Math.floor(len / 2))
  for (let i = 0; i < len; i++) {
    const idx = start + i
    if (idx >= buf.length) break
    let env = 1
    if (i < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp)
    else if (i > len - ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * (len - i)) / ramp)
    const v = Math.sin((2 * Math.PI * hz * i) / RATE) * amp * env
    buf[idx] = Math.max(0, Math.min(255, Math.round(SILENCE + v * 110)))
  }
}

function silence(sec: number): Uint8Array {
  return new Uint8Array(Math.round(sec * RATE)).fill(SILENCE)
}

// Heel-slide pacer: ten evenly spaced tones over six seconds. Ray moves on each
// tone; the count is the exercise prescription made audible.
const pacer = silence(6)
for (let n = 0; n < 10; n++) burst(pacer, 0.08 + n * 0.6, 0.12, 880, 1)

// Gait cadence captured at the home visit. The step interval is deliberately
// asymmetric — 0.38 s off the operated side, 0.62 s onto it — which is the whole
// clinical content of the file, and the reason it is audience:["assistant"].
const gait = silence(3)
let t = 0.1
for (let n = 0; n < 6; n++) {
  burst(gait, t, 0.04, 240, 0.75)
  t += n % 2 === 0 ? 0.38 : 0.62
}

const out = new URL('.', import.meta.url)
writeFileSync(new URL('heel-slide-pacer.wav', out), wav(pacer))
writeFileSync(new URL('gait-cadence.wav', out), wav(gait))
console.log('fixtures/heel-slide-pacer.wav', 44 + pacer.length, 'bytes')
console.log('fixtures/gait-cadence.wav', 44 + gait.length, 'bytes')
