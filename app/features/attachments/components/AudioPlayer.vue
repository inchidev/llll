<script setup lang="ts">
import { formatAudioDuration } from '~~/shared/audio'

const props = defineProps<{
  src: string
  label?: string
}>()

const audio = shallowRef<HTMLAudioElement | null>(null)
const playing = ref(false)
const loading = ref(false)
const failed = ref(false)
const duration = ref(0)
const currentTime = ref(0)
const seeking = ref(false)
let frame: number | undefined
let discoveringDuration = false

const bars = Array.from({ length: 44 }, (_, index) => 24 + ((index * 29 + (index % 5) * 11) % 70))
const progress = computed(() => duration.value > 0 ? Math.min(100, currentTime.value / duration.value * 100) : 0)
const elapsedLabel = computed(() => formatAudioDuration(currentTime.value * 1000))
const durationLabel = computed(() => duration.value > 0 ? formatAudioDuration(duration.value * 1000) : '0:00')

function syncDuration() {
  const element = audio.value
  if (!element) return
  if (Number.isFinite(element.duration) && element.duration > 0) {
    duration.value = element.duration
    if (discoveringDuration) {
      discoveringDuration = false
      element.currentTime = 0
      currentTime.value = 0
    }
    return
  }
  if (element.duration === Infinity && !discoveringDuration) {
    discoveringDuration = true
    element.currentTime = Number.MAX_SAFE_INTEGER
  }
}

function syncProgress() {
  if (!seeking.value && audio.value) currentTime.value = audio.value.currentTime
  if (playing.value) frame = requestAnimationFrame(syncProgress)
}

function startProgress() {
  playing.value = true
  loading.value = false
  if (frame) cancelAnimationFrame(frame)
  frame = requestAnimationFrame(syncProgress)
}

function stopProgress() {
  playing.value = false
  if (frame) cancelAnimationFrame(frame)
  frame = undefined
  if (audio.value && !seeking.value) currentTime.value = audio.value.currentTime
}

async function togglePlayback() {
  const element = audio.value
  if (!element || failed.value) return
  if (!element.paused) {
    element.pause()
    return
  }
  loading.value = true
  try {
    await element.play()
  }
  catch {
    loading.value = false
    failed.value = true
  }
}

function seek(event: Event) {
  const next = Number((event.currentTarget as HTMLInputElement).value)
  currentTime.value = next
  if (audio.value) audio.value.currentTime = next
}

function finishSeek() {
  seeking.value = false
  if (audio.value) currentTime.value = audio.value.currentTime
}

function reset() {
  stopProgress()
  failed.value = false
  loading.value = false
  currentTime.value = 0
  duration.value = 0
  audio.value?.load()
}

function markFailed() {
  loading.value = false
  failed.value = true
}

watch(() => props.src, reset)
onMounted(syncDuration)
onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame)
  audio.value?.pause()
})
</script>

<template>
  <div class="flex h-12 w-full max-w-sm items-center gap-2.5 rounded-lg bg-muted px-2.5" :title="label">
    <audio
      ref="audio"
      :src="src"
      preload="metadata"
      @loadedmetadata="syncDuration"
      @durationchange="syncDuration"
      @timeupdate="syncDuration"
      @play="startProgress"
      @playing="startProgress"
      @pause="stopProgress"
      @ended="stopProgress"
      @waiting="loading = true"
      @canplay="loading = false"
      @error="markFailed"
    />
    <UButton
      :icon="failed ? 'i-ph-warning' : playing ? 'i-ph-pause-fill' : 'i-ph-play-fill'"
      color="primary"
      variant="solid"
      size="sm"
      square
      class="shrink-0 rounded-full"
      :loading="loading"
      :disabled="failed"
      :aria-label="failed ? `Could not play ${label || 'audio'}` : playing ? `Pause ${label || 'audio'}` : `Play ${label || 'audio'}`"
      @click="togglePlayback"
    />

    <div class="min-w-0 flex-1">
      <div class="relative h-7 overflow-hidden">
        <div class="absolute inset-0 flex items-center gap-px" aria-hidden="true">
          <span
            v-for="(height, index) in bars"
            :key="`base-${index}`"
            class="min-w-0 flex-1 rounded-full transition-colors duration-75"
            :class="((index + 0.5) / bars.length * 100) <= progress ? 'bg-primary' : 'bg-accented'"
            :style="{ height: `${height}%` }"
          />
        </div>
        <input
          class="audio-wave-range absolute inset-0 size-full cursor-pointer rounded-sm bg-transparent focus-visible:outline-2 focus-visible:outline-primary"
          type="range"
          min="0"
          :max="duration || 0"
          step="0.01"
          :value="currentTime"
          :disabled="!duration || failed"
          :aria-label="`Seek ${label || 'audio'}`"
          @pointerdown="seeking = true"
          @input="seek"
          @change="finishSeek"
          @pointerup="finishSeek"
          @pointercancel="finishSeek"
        >
      </div>
      <div class="flex items-center justify-between font-mono text-[10px] leading-none tabular-nums text-muted" aria-live="off">
        <span>{{ elapsedLabel }}</span>
        <span>{{ durationLabel }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.audio-wave-range {
  appearance: none;
}

.audio-wave-range::-webkit-slider-runnable-track {
  height: 100%;
  background: transparent;
}

.audio-wave-range::-webkit-slider-thumb {
  width: 1px;
  height: 100%;
  appearance: none;
  background: transparent;
}

.audio-wave-range::-moz-range-track {
  height: 100%;
  background: transparent;
}

.audio-wave-range::-moz-range-thumb {
  width: 1px;
  height: 100%;
  border: 0;
  background: transparent;
}
</style>
