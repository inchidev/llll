import { pcm16Wav, SPEECH_SAMPLE_RATE } from '~~/shared/audio'
import type { RecordingClip, RecordingSaid } from '~~/shared/task-recordings'

// Sound decoded here, never on the Server, sent a minute at a time as 16 kHz mono WAV.

const CHUNK = 60
const SILENCE = 0.003 // RMS below this is a recording without a voice

/** null: the recording has no audio track. []: it has one, but nobody talks. */
export async function audioChunks(data: ArrayBuffer): Promise<{ at: number; wav: Blob }[] | null> {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const context = new Context()
  let decoded: AudioBuffer
  try { decoded = await context.decodeAudioData(data) }
  catch { return null }
  finally { context.close().catch(() => {}) }

  const rate = SPEECH_SAMPLE_RATE
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const mono = (await offline.startRendering()).getChannelData(0)
  if (rms(mono, 0, mono.length) < SILENCE) return []

  const chunks: { at: number; wav: Blob }[] = []
  for (let start = 0; start < mono.length;) {
    let end = Math.min(mono.length, start + CHUNK * rate)
    if (end < mono.length) end = quietest(mono, end - 5 * rate, end)
    chunks.push({ at: start / rate, wav: new Blob([pcm16Wav(mono.subarray(start, end))], { type: 'audio/wav' }) })
    start = end
  }
  return chunks
}

/** Phrases close together become one clip; a pause of a second or more starts the next one. */
export function clipsFromSpeech(said: RecordingSaid[]): RecordingClip[] {
  const clips: RecordingClip[] = []
  for (const phrase of said) {
    const last = clips.at(-1)
    if (last && phrase.start - last.end < 1 && phrase.end - last.start < 15) {
      last.end = phrase.end
      last.comment = `${last.comment} ${phrase.text}`
    }
    else {
      clips.push({ start: phrase.start, end: phrase.end, box: null, comment: phrase.text })
    }
  }
  return clips
}

/** The quietest 100 ms between from and to, so a chunk does not cut a word in half. */
function quietest(samples: Float32Array, from: number, to: number) {
  const step = SPEECH_SAMPLE_RATE / 10
  let best = to
  let bestLevel = Infinity
  for (let at = Math.max(0, from); at + step <= to; at += step) {
    const level = rms(samples, at, at + step)
    if (level < bestLevel) { bestLevel = level; best = at + step / 2 }
  }
  return Math.round(best)
}

function rms(samples: Float32Array, from: number, to: number) {
  let sum = 0
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / Math.max(1, to - from))
}
