import { audioFileExtension, MAX_AUDIO_RECORDING_MS, selectAudioRecordingMime } from '~~/shared/audio'

type AudioRecorderOptions = {
  onRecorded: (file: File) => void
  onError: (message: string) => void
  onLimit: () => void
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') return 'Microphone access was denied'
  if (error instanceof DOMException && error.name === 'NotFoundError') return 'No microphone was found'
  return 'Could not start audio recording'
}

export function useAudioRecorder(options: AudioRecorderOptions) {
  const recording = ref(false)
  const elapsedMs = ref(0)
  const recorder = shallowRef<MediaRecorder | null>(null)
  const stream = shallowRef<MediaStream | null>(null)
  let chunks: Blob[] = []
  let startedAt = 0
  let cancelled = false
  let disposed = false
  let elapsedTimer: ReturnType<typeof setInterval> | undefined
  let limitTimer: ReturnType<typeof setTimeout> | undefined

  function clearTimers() {
    if (elapsedTimer) clearInterval(elapsedTimer)
    if (limitTimer) clearTimeout(limitTimer)
    elapsedTimer = undefined
    limitTimer = undefined
  }

  function releaseStream() {
    for (const track of stream.value?.getTracks() ?? []) track.stop()
    stream.value = null
  }

  function reset() {
    clearTimers()
    releaseStream()
    recorder.value = null
    recording.value = false
    elapsedMs.value = 0
    chunks = []
  }

  async function start() {
    if (recording.value) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      options.onError('Audio recording needs HTTPS and a supported browser')
      return
    }

    let acquired: MediaStream
    try {
      acquired = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      })
    }
    catch (error) {
      options.onError(microphoneErrorMessage(error))
      return
    }

    if (disposed) {
      for (const track of acquired.getTracks()) track.stop()
      return
    }

    try {
      const mime = selectAudioRecordingMime(type => MediaRecorder.isTypeSupported(type))
      const next = mime ? new MediaRecorder(acquired, { mimeType: mime }) : new MediaRecorder(acquired)
      stream.value = acquired
      recorder.value = next
      chunks = []
      cancelled = false

      next.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.push(event.data)
      })
      next.addEventListener('error', () => {
        cancelled = true
        options.onError('Audio recording failed')
        if (next.state === 'recording') next.stop()
        else reset()
      })
      next.addEventListener('stop', () => {
        const type = next.mimeType || chunks[0]?.type || 'audio/webm'
        const blob = new Blob(chunks, { type })
        const shouldKeep = !cancelled && blob.size > 0 && !disposed
        reset()
        if (!shouldKeep) return
        const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')
        options.onRecorded(new File([blob], `audio-${stamp}.${audioFileExtension(type)}`, { type }))
      })

      next.start(1000)
      startedAt = Date.now()
      recording.value = true
      elapsedTimer = setInterval(() => {
        elapsedMs.value = Date.now() - startedAt
      }, 250)
      limitTimer = setTimeout(() => {
        options.onLimit()
        stop()
      }, MAX_AUDIO_RECORDING_MS)
    }
    catch (error) {
      reset()
      for (const track of acquired.getTracks()) track.stop()
      options.onError(microphoneErrorMessage(error))
    }
  }

  function stop() {
    if (recorder.value?.state === 'recording') recorder.value.stop()
  }

  function cancel() {
    cancelled = true
    if (recorder.value?.state === 'recording') recorder.value.stop()
    else reset()
  }

  onBeforeUnmount(() => {
    disposed = true
    cancel()
  })

  return { recording: readonly(recording), elapsedMs: readonly(elapsedMs), start, stop, cancel }
}
