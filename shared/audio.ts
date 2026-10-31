export const MAX_AUDIO_RECORDING_MS = 5 * 60 * 1000

// Voice transcription models take MP4/AAC and Ogg, rarely WebM: prefer what they read.
export const AUDIO_RECORDING_MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
] as const

export function selectAudioRecordingMime(isSupported: (mime: string) => boolean): string | undefined {
  return AUDIO_RECORDING_MIME_CANDIDATES.find(isSupported)
}

export function audioFileExtension(mime: string): string {
  if (mime.startsWith('audio/mp4')) return 'm4a'
  if (mime.startsWith('audio/ogg')) return 'ogg'
  if (mime.startsWith('audio/wav')) return 'wav'
  return 'webm'
}

export function formatAudioDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/** Speech-model rate: voice messages are sent as 16 kHz mono WAV, which every transcription model reads. */
export const SPEECH_SAMPLE_RATE = 16_000

/** A 16-bit PCM WAV file from mono samples in [-1, 1]. */
export function pcm16Wav(samples: Float32Array, sampleRate = SPEECH_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]!))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return bytes
}
