export const MAX_AUDIO_RECORDING_MS = 5 * 60 * 1000

export const AUDIO_RECORDING_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
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
