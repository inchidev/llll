<script setup lang="ts">
import { selectAudioRecordingMime } from '~~/shared/audio'
import type { RecordingClip, RecordingLimitsDTO, RecordingSaid } from '~~/shared/task-recordings'
import { formatRecordingTime, makeFrames, type Box } from '~/utils/recording-frames'
import { audioChunks, clipsFromSpeech } from '~/utils/recording-voice'

/**
 * Marking, laid out for a phone: one row on top (comment, voice, add, send), the picture fills the
 * rest, and a video gets one more row at the bottom (play, timeline, in/out, box). It works on the
 * local file, and nothing reaches the Server until Send, which adds it to the open Task. A file that
 * came from the Shortcut is `uploaded` instead: already a Task, which Save updates.
 */
const props = defineProps<{
  file?: File | null; uploaded?: { id: string; taskId: string; url: string; contentType: string } | null
  limits: RecordingLimitsDTO; taskId?: string | null
}>()
const emit = defineEmits<{ sent: [taskId: string]; cancel: [] }>()
const { api } = useApi()
const { upload, progress: uploadProgress } = useRecordingUpload()

const source = ref('')
const isImage = computed(() => (props.uploaded?.contentType ?? props.file?.type ?? '').startsWith('image/'))
const targetTaskId = props.uploaded?.taskId ?? props.taskId!
// Kept across a failed Send, so trying again doesn't upload the file twice.
let recordingId: string | null = props.uploaded?.id ?? null
const video = ref<HTMLVideoElement>()
const image = ref<HTMLImageElement>()
const media = ref<HTMLDivElement>()
const stage = ref<HTMLDivElement>()
const track = ref<HTMLDivElement>()
const status = ref<'loading' | 'ready' | 'sending' | 'failed'>('loading')
const error = ref('')
const duration = ref(0)
const current = ref(0)
const playing = ref(false)
const aspect = ref(9 / 16)
const stageSize = ref({ w: 0, h: 0 })

const clips = ref<RecordingClip[]>([])
const transcript = ref<RecordingSaid[]>([])
const start = ref<number | null>(null)
const end = ref<number | null>(null)
const box = ref<Box | null>(null)
const comment = ref('')
const drawing = ref(false)
const progress = ref({ done: 0, total: 0, phase: '' })
const voiceBusy = ref(false)
const voiceNote = ref('')

const selection = computed(() => {
  if (start.value === null && end.value === null) return null
  const a = start.value ?? end.value!
  const b = end.value ?? start.value!
  return { start: Math.min(a, b), end: Math.max(a, b) }
})
const hasDraft = computed(() => selection.value !== null || box.value !== null || comment.value.trim() !== '')
// One finger draws on a screenshot right away; on a video only after tapping the box button.
const boxMode = computed(() => isImage.value || drawing.value)

// The picture's rendered size: as large as the stage allows at its own aspect ratio.
const mediaSize = computed(() => {
  const { w, h } = stageSize.value
  if (!w || !h) return { w: 0, h: 0 }
  const width = Math.min(w, h * aspect.value)
  return { w: width, h: width / aspect.value }
})

let observer: ResizeObserver | undefined
onMounted(() => {
  source.value = props.uploaded?.url ?? URL.createObjectURL(props.file!)
  observer = new ResizeObserver(() => {
    if (stage.value) stageSize.value = { w: stage.value.clientWidth, h: stage.value.clientHeight }
  })
  watch(stage, (element) => { if (element) observer?.observe(element) }, { immediate: true })
})
onBeforeUnmount(() => {
  observer?.disconnect()
  recorder?.stop()
  if (source.value && !props.uploaded) URL.revokeObjectURL(source.value)
})

function onLoaded() {
  const element = video.value!
  duration.value = element.duration
  if (element.videoWidth && element.videoHeight) aspect.value = element.videoWidth / element.videoHeight
  // iOS Safari shows a black box until playback has started once; a muted play+pause draws the first frame.
  if (element.paused && element.currentTime === 0) element.play().then(() => { element.pause(); element.currentTime = 0 }).catch(() => {})
  if (status.value === 'loading') status.value = 'ready'
}

function onImageLoaded() {
  const element = image.value!
  if (element.naturalWidth && element.naturalHeight) aspect.value = element.naturalWidth / element.naturalHeight
  status.value = 'ready'
}

function fail(message: string) {
  error.value = message
  status.value = 'failed'
}

function togglePlay() {
  const element = video.value
  if (!element) return
  if (element.paused) element.play().catch(() => {})
  else element.pause()
}

function scrub(event: PointerEvent) {
  if (event.type === 'pointermove' && !(event.buttons & 1)) return
  if (event.type === 'pointerdown') (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  const rect = track.value!.getBoundingClientRect()
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  video.value!.pause()
  video.value!.currentTime = current.value = fraction * duration.value
}

// Read the element, not `current`: a tap right after scrubbing can beat the "seeked" event.
const now = () => video.value?.currentTime ?? 0
const pct = (t: number) => `${(duration.value ? t / duration.value : 0) * 100}%`

// One finger draws the box (or plays/pauses a video), two fingers pinch and pan the picture.
const zoom = ref({ scale: 1, x: 0, y: 0 })
const zoomed = computed(() => zoom.value.scale > 1.01)
const pointers = new Map<number, { x: number; y: number }>()
let pinch: { distance: number; mid: { x: number; y: number }; start: { scale: number; x: number; y: number } } | null = null
let origin: { x: number; y: number } | null = null
let boxBefore: Box | null = null
let tapTimer: ReturnType<typeof setTimeout> | null = null

function point(event: PointerEvent) {
  // The transformed element's rect already includes zoom and pan.
  const rect = media.value!.getBoundingClientRect()
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  }
}

function pinchState() {
  const [a, b] = [...pointers.values()]
  return { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } }
}

function stageDown(event: PointerEvent) {
  if (status.value !== 'ready') return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  // The first finger down starts a new gesture; iOS does not always deliver every pointerup.
  if (event.isPrimary) { pointers.clear(); pinch = null; origin = null }
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (pointers.size === 2) {
    // The first finger may have started a box: undo it, this is a pinch.
    if (origin) { box.value = boxBefore; origin = null }
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = null }
    pinch = { ...pinchState(), start: { ...zoom.value } }
    return
  }
  if (pointers.size > 2) return
  if (!boxMode.value) {
    // Toggle playback on a tap, not when the finger starts a drag.
    tapTimer = setTimeout(() => { tapTimer = null }, 250)
    return
  }
  video.value?.pause()
  boxBefore = box.value
  origin = point(event)
  box.value = { ...origin, w: 0, h: 0 }
}

function stageMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (pinch && pointers.size === 2) {
    const { distance, mid } = pinchState()
    const scale = Math.min(6, Math.max(1, pinch.start.scale * (distance / pinch.distance)))
    const x = pinch.start.x + (mid.x - pinch.mid.x)
    const y = pinch.start.y + (mid.y - pinch.mid.y)
    zoom.value = scale === 1 ? { scale: 1, x: 0, y: 0 } : { scale, x, y }
    return
  }
  if (!origin) return
  const p = point(event)
  box.value = { x: Math.min(origin.x, p.x), y: Math.min(origin.y, p.y), w: Math.abs(p.x - origin.x), h: Math.abs(p.y - origin.y) }
}

function stageUp(event: PointerEvent) {
  pointers.delete(event.pointerId)
  if (pinch) {
    if (pointers.size === 0) pinch = null
    return
  }
  if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; togglePlay() }
  if (!origin) return
  origin = null
  // A sliver is almost always a finger that slipped, not a mark.
  if (box.value && (box.value.w < 0.04 || box.value.h < 0.04)) box.value = boxBefore
  else drawing.value = false
}

async function hearChunks(chunks: { at: number; wav: Blob }[]): Promise<RecordingSaid[]> {
  const said: RecordingSaid[] = []
  for (const [index, chunk] of chunks.entries()) {
    voiceNote.value = chunks.length > 1 ? `Listening ${index + 1}/${chunks.length}…` : 'Listening…'
    const answer = await api<{ segments: RecordingSaid[] }>('/api/tasks/transcribe', { method: 'POST', query: { at: chunk.at }, headers: { 'Content-Type': 'audio/wav' }, body: chunk.wav })
    said.push(...answer.segments)
  }
  return said
}

// The microphone: spoken words go into the comment, and are timed from this moment of the recording.
let recorder: MediaRecorder | null = null
const recording = ref(false)
async function toggleRecording() {
  if (recorder) { recorder.stop(); return }
  error.value = ''
  voiceNote.value = ''
  let stream: MediaStream
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
  catch { error.value = 'The microphone is not available here. Allow it in your browser, or type the comment.'; return }
  const parts: Blob[] = []
  const mimeType = selectAudioRecordingMime(type => MediaRecorder.isTypeSupported(type))
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  recording.value = true
  const startedAt = now()
  recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data) }
  recorder.onstop = async () => {
    stream.getTracks().forEach(track => track.stop())
    recorder = null
    recording.value = false
    voiceBusy.value = true
    try {
      const chunks = await audioChunks(await new Blob(parts).arrayBuffer())
      if (!chunks?.length) { voiceNote.value = 'Nothing that sounded like words.'; return }
      const said = (await hearChunks(chunks)).map(phrase => ({ ...phrase, start: startedAt + phrase.start, end: startedAt + phrase.end }))
      transcript.value.push(...said)
      comment.value = [comment.value.trim(), ...said.map(phrase => phrase.text)].filter(Boolean).join(' ')
      voiceNote.value = said.length ? '' : 'Nothing that sounded like words.'
    }
    catch (cause) { error.value = errorMessage(cause) }
    finally { voiceBusy.value = false }
  }
  recorder.start()
}

// The recording's own sound: what was said while recording becomes clips the person can still edit.
async function transcribeRecording() {
  if (voiceBusy.value) return
  voiceBusy.value = true
  error.value = ''
  voiceNote.value = 'Reading the sound…'
  try {
    const bytes = props.file ? await props.file.arrayBuffer() : await (await fetch(props.uploaded!.url, { credentials: 'include' })).arrayBuffer()
    const chunks = await audioChunks(bytes)
    if (chunks === null || chunks.length === 0) {
      voiceNote.value = 'No voice in this recording. Next time, turn the microphone on when you start recording the screen.'
      return
    }
    const said = await hearChunks(chunks)
    transcript.value = said
    const fresh = clipsFromSpeech(said).filter(clip => !clips.value.some(existing => Math.abs(existing.start - clip.start) < 0.5))
    clips.value.push(...fresh)
    clips.value.sort((a, b) => a.start - b.start)
    voiceNote.value = !said.length
      ? 'Nothing that sounded like words.'
      : fresh.length
        ? `${fresh.length} clip${fresh.length === 1 ? '' : 's'} from what you said. Tap one to fix the words or add a box.`
        : 'Your marks already cover those moments. What you said goes to the agent too.'
  }
  catch (cause) {
    voiceNote.value = ''
    error.value = errorMessage(cause)
  }
  finally { voiceBusy.value = false }
}

function draftClip(): RecordingClip {
  const range = selection.value ?? { start: now(), end: now() }
  return { start: range.start, end: range.end, box: box.value, comment: comment.value.trim() }
}

function addClip() {
  if (!hasDraft.value) return
  clips.value.push(draftClip())
  clips.value.sort((a, b) => a.start - b.start)
  start.value = end.value = null
  box.value = null
  comment.value = ''
}

function editClip(index: number) {
  if (hasDraft.value) addClip()
  const [clip] = clips.value.splice(index, 1)
  if (!clip) return
  start.value = isImage.value ? null : clip.start
  end.value = isImage.value ? null : clip.end
  box.value = clip.box
  comment.value = clip.comment
  if (video.value) video.value.currentTime = clip.start
}

async function send() {
  if (recorder) recorder.stop()
  if (hasDraft.value) addClip()
  const element = video.value
  status.value = 'sending'
  error.value = ''
  try {
    if (element) {
      // iOS only decodes frames after a user gesture has started playback once.
      await element.play().catch(() => {})
      element.pause()
    }
    progress.value = { done: 0, total: 0, phase: 'Making frames' }
    const frames = await makeFrames(element ?? image.value!, clips.value, '', (done, total) => { progress.value = { done, total, phase: 'Making frames' } })
    if (!recordingId) {
      const watch = setInterval(() => { progress.value = { done: Math.round(uploadProgress.value * 100), total: 100, phase: 'Uploading the recording' } }, 200)
      try { recordingId = (await upload(targetTaskId, props.file!)).id }
      finally { clearInterval(watch) }
    }
    // A few at a time: on a phone connection, one after another is what makes Send feel slow.
    let uploaded = 0
    const queue = [...frames]
    const uploadNext = async () => {
      for (let frame = queue.shift(); frame; frame = queue.shift()) {
        const form = new FormData()
        form.append('file', frame.blob, frame.name)
        form.append('sourceId', recordingId!)
        form.append('frame', JSON.stringify({ clip: frame.clip, t: frame.t, zoom: frame.zoom }))
        await api(`/api/tasks/${targetTaskId}/attachments`, { method: 'POST', body: form })
        progress.value = { done: ++uploaded, total: frames.length, phase: 'Uploading frames' }
      }
    }
    progress.value = { done: 0, total: frames.length, phase: 'Uploading frames' }
    await Promise.all(Array.from({ length: 4 }, uploadNext))
    await api(`/api/task-attachments/${recordingId}/finish`, { method: 'POST', body: { duration: element ? element.duration : null, clips: clips.value, transcript: transcript.value } })
    emit('sent', targetTaskId)
  }
  catch (cause) {
    error.value = errorMessage(cause)
    status.value = 'ready'
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex min-h-0 flex-col bg-default">
    <header class="z-10 flex h-[calc(3rem+var(--df-safe-area-top))] shrink-0 items-center gap-2 bg-default px-3 pt-[var(--df-safe-area-top)] shadow-[0_1px_0_var(--ui-border)]">
      <h1 class="min-w-0 flex-1 truncate text-[15px] font-semibold text-highlighted">{{ uploaded ? 'Mark this recording' : 'Add a recording' }}</h1>
      <UButton color="neutral" variant="ghost" :label="uploaded ? 'Later' : 'Cancel'" :disabled="status === 'sending'" @click="emit('cancel')" />
      <UButton :icon="uploaded ? 'i-ph-check' : 'i-ph-paper-plane-tilt'" :label="uploaded ? 'Save' : 'Send'" :loading="status === 'sending'" :disabled="status === 'loading' || status === 'failed' || recording" @click="send" />
    </header>

    <div v-if="status === 'failed'" class="p-4"><UAlert color="error" variant="subtle" :title="error" /></div>
    <template v-else>
      <div class="z-10 shrink-0 space-y-2 border-b border-default bg-default px-3 py-2">
        <slot name="destination" />
        <div class="flex items-end gap-1.5">
          <UTextarea v-model="comment" :rows="1" :maxrows="4" autoresize class="min-w-0 flex-1" :placeholder="recording ? 'Listening…' : 'What’s wrong here?'" aria-label="Comment" :disabled="status === 'sending'" />
          <UButton v-if="limits.voice" :icon="recording ? 'i-ph-stop' : 'i-ph-microphone'" :color="recording ? 'error' : 'neutral'" :variant="recording ? 'solid' : 'soft'" :aria-label="recording ? 'Stop and transcribe' : 'Say it'" :loading="voiceBusy && !recording" :disabled="status === 'sending'" @click="toggleRecording" />
          <UButton icon="i-ph-plus" color="neutral" variant="soft" :aria-label="isImage ? 'Add another box' : 'Add another clip'" :disabled="!hasDraft || status === 'sending'" @click="addClip" />
        </div>
        <div v-if="clips.length" class="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          <button v-for="(clip, index) in clips" :key="index" type="button" class="flex shrink-0 items-center gap-1.5 rounded-lg bg-elevated px-2.5 py-1 text-xs" @click="editClip(index)">
            <span class="font-mono text-primary">{{ index + 1 }}</span>
            <span class="max-w-40 truncate">{{ clip.comment || (isImage ? 'Box' : formatRecordingTime(clip.start)) }}</span>
            <UIcon name="i-ph-x" class="size-3.5 text-muted" :aria-label="`Remove mark ${index + 1}`" @click.stop="clips.splice(index, 1)" />
          </button>
        </div>
        <p v-if="status === 'sending'" class="text-xs text-muted" role="status">{{ progress.phase }} {{ progress.done }}/{{ progress.total || '…' }}</p>
        <p v-else-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
        <p v-else-if="voiceNote" class="text-xs text-muted" role="status">{{ voiceNote }}</p>
      </div>

      <!-- The picture takes all remaining height. Buttons sit beside the drawing surface, not in it. -->
      <div class="relative min-h-0 flex-1">
        <div ref="stage" class="absolute inset-0 touch-none select-none overflow-hidden bg-black" @pointerdown="stageDown" @pointermove="stageMove" @pointerup="stageUp" @pointercancel="stageUp">
          <div ref="media" class="absolute left-1/2 top-1/2 origin-center" :style="{ width: `${mediaSize.w}px`, height: `${mediaSize.h}px`, transform: `translate(-50%, -50%) translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }">
            <img v-if="isImage" ref="image" :src="source" alt="The shared screenshot" class="pointer-events-none size-full" draggable="false" @load="onImageLoaded" @error="fail('This picture could not be shown here.')">
            <video
              v-else ref="video" :src="source" class="pointer-events-none size-full" playsinline muted preload="auto"
              @loadedmetadata="onLoaded" @timeupdate="current = video!.currentTime" @seeked="current = video!.currentTime"
              @play="playing = true" @pause="playing = false" @error="fail('This video could not be played here.')"
            />
            <div v-if="box" class="pointer-events-none absolute border-[#ff6933] shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" :style="{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`, borderWidth: `${3 / zoom.scale}px` }" />
          </div>
          <div v-if="status === 'loading'" class="absolute inset-0 grid place-items-center text-sm text-white/70">Loading…</div>
          <div v-else-if="boxMode && !box" class="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
            <span class="whitespace-nowrap rounded-lg bg-black/70 px-3 py-1 text-xs font-medium text-white">Drag a box · pinch to zoom</span>
          </div>
        </div>
        <div class="absolute bottom-2 right-2 z-10 flex gap-1.5">
          <UButton v-if="zoomed" size="xs" color="neutral" variant="solid" label="1×" @click="zoom = { scale: 1, x: 0, y: 0 }" />
          <UButton v-if="box" size="xs" color="neutral" variant="solid" icon="i-ph-x" label="Box" @click="box = null" />
        </div>
      </div>

      <!-- Video only: one row of controls. -->
      <div v-if="!isImage" class="flex shrink-0 items-center gap-1.5 border-t border-default px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <UButton :icon="playing ? 'i-ph-pause' : 'i-ph-play'" color="neutral" variant="ghost" :aria-label="playing ? 'Pause' : 'Play'" @click="togglePlay" />
        <div ref="track" class="relative h-9 min-w-0 flex-1 touch-none rounded-md bg-elevated" role="slider" aria-label="Timeline" :aria-valuenow="Math.round(current)" :aria-valuemax="Math.round(duration)" aria-valuemin="0" @pointerdown="scrub" @pointermove="scrub">
          <div v-for="(clip, index) in clips" :key="index" class="absolute inset-y-1 rounded-sm bg-primary/35" :style="{ left: pct(clip.start), width: `max(3px, ${pct(clip.end - clip.start)})` }" />
          <div v-if="selection" class="absolute inset-y-0 rounded-sm border-2 border-primary bg-primary/20" :style="{ left: pct(selection.start), width: `max(4px, ${pct(selection.end - selection.start)})` }" />
          <div class="pointer-events-none absolute inset-y-0 w-0.5 bg-highlighted" :style="{ left: pct(current) }" />
          <span class="pointer-events-none absolute bottom-0.5 left-1.5 font-mono text-[10px] text-muted">{{ formatRecordingTime(current) }}</span>
        </div>
        <UButton :color="start === null ? 'neutral' : 'primary'" variant="soft" size="sm" class="font-mono" label="In" aria-label="Clip starts here" @click="start = now()" />
        <UButton :color="end === null ? 'neutral' : 'primary'" variant="soft" size="sm" class="font-mono" label="Out" aria-label="Clip ends here" @click="end = now()" />
        <UButton icon="i-ph-selection" :color="drawing ? 'primary' : 'neutral'" :variant="drawing ? 'solid' : 'soft'" aria-label="Box the spot" @click="drawing = !drawing" />
        <UButton v-if="limits.voice" icon="i-ph-waveform" color="neutral" variant="soft" :loading="voiceBusy" aria-label="Turn what you said into clips" @click="transcribeRecording" />
      </div>
    </template>
  </div>
</template>
