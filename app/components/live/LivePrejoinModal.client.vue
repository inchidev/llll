<script setup lang="ts">
import type { LiveKind } from '~~/shared/types'
import { liveJoinLabel, liveStartLabel } from '~~/shared/live'
import type { LiveJoinOptions } from '../../composables/useLiveSession'

const props = defineProps<{
  open: boolean
  title: string
  kind: LiveKind
  action: 'start' | 'join'
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'confirm': [options: LiveJoinOptions]
}>()

const live = useLiveStore()
const actionLabel = computed(() => props.action === 'start' ? liveStartLabel(props.kind) : liveJoinLabel(props.kind))
const preview = useTemplateRef<HTMLVideoElement>('preview')
// Start from the mute preference set in the user panel.
const audio = ref(!live.muted)
const video = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const audioInputId = ref('')
const videoInputId = ref('')
const audioOutputId = ref('')
const devices = shallowRef<MediaDeviceInfo[]>([])
let stream: MediaStream | null = null
let previewGeneration = 0

const deviceItems = (kind: MediaDeviceKind) => computed(() => mediaDeviceItems(devices.value, kind))
const microphones = deviceItems('audioinput')
const cameras = deviceItems('videoinput')
const speakers = deviceItems('audiooutput')

function stopPreview(invalidate = true) {
  if (invalidate) previewGeneration += 1
  for (const track of stream?.getTracks() ?? []) track.stop()
  stream = null
  if (preview.value) preview.value.srcObject = null
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  devices.value = await navigator.mediaDevices.enumerateDevices()
  audioInputId.value ||= microphones.value[0]?.value || ''
  videoInputId.value ||= cameras.value[0]?.value || ''
  audioOutputId.value ||= speakers.value[0]?.value || ''
}

async function startPreview() {
  const generation = ++previewGeneration
  stopPreview(false)
  error.value = null
  if (!props.open || (!audio.value && !video.value)) {
    await refreshDevices()
    return
  }
  loading.value = true
  try {
    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio: audio.value ? { deviceId: audioInputId.value ? { exact: audioInputId.value } : undefined } : false,
      video: video.value ? { deviceId: videoInputId.value ? { exact: videoInputId.value } : undefined } : false,
    })
    if (generation !== previewGeneration) {
      for (const track of nextStream.getTracks()) track.stop()
      return
    }
    stream = nextStream
    if (preview.value) {
      preview.value.srcObject = stream
      await preview.value.play().catch(() => undefined)
    }
    await refreshDevices()
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Camera or microphone is unavailable'
    await refreshDevices()
  }
  finally {
    loading.value = false
  }
}

watch(() => props.open, (open) => {
  if (open) {
    audio.value = !live.muted
    void startPreview()
  }
  else stopPreview()
})
watch([audio, video, audioInputId, videoInputId], () => {
  if (props.open) void startPreview()
})
onUnmounted(stopPreview)

function confirm() {
  emit('confirm', {
    audio: audio.value,
    video: video.value,
    audioInputId: audioInputId.value || undefined,
    videoInputId: videoInputId.value || undefined,
    audioOutputId: audioOutputId.value || undefined,
    title: props.title,
    kind: props.kind,
  })
}
</script>

<template>
  <UModal
    :open="open"
    :title="actionLabel"
    :description="title"
    :ui="{ content: 'sm:max-w-2xl' }"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div class="grid gap-5 md:grid-cols-[minmax(0,1fr)_240px]">
        <div class="relative aspect-video overflow-hidden rounded-xl bg-black">
          <video v-show="video" ref="preview" muted playsinline class="size-full object-cover -scale-x-100" />
          <div v-if="!video" class="absolute inset-0 grid place-items-center">
            <div class="grid size-20 place-items-center rounded-full bg-elevated text-muted">
              <UIcon name="i-ph-user" class="size-9" />
            </div>
          </div>
          <UBadge v-if="loading" class="absolute left-3 top-3" color="neutral" icon="i-ph-circle-notch" label="Checking devices" />
        </div>
        <div class="space-y-4">
          <UFormField label="Microphone">
            <USelect v-model="audioInputId" :items="microphones" value-key="value" class="w-full" :disabled="!audio" />
          </UFormField>
          <UFormField label="Camera">
            <USelect v-model="videoInputId" :items="cameras" value-key="value" class="w-full" :disabled="!video" />
          </UFormField>
          <UFormField v-if="speakers.length" label="Speaker">
            <USelect v-model="audioOutputId" :items="speakers" value-key="value" class="w-full" />
          </UFormField>
          <div class="flex gap-2">
            <UButton
              :icon="audio ? 'i-ph-microphone' : 'i-ph-microphone-slash'"
              :color="audio ? 'neutral' : 'error'"
              :variant="audio ? 'outline' : 'soft'"
              :label="audio ? 'Mic on' : 'Mic off'"
              @click="audio = !audio"
            />
            <UButton
              :icon="video ? 'i-ph-video-camera' : 'i-ph-video-camera-slash'"
              :color="video ? 'neutral' : 'error'"
              :variant="video ? 'outline' : 'soft'"
              :label="video ? 'Camera on' : 'Camera off'"
              @click="video = !video"
            />
          </div>
        </div>
      </div>
      <UAlert v-if="error" color="warning" variant="subtle" class="mt-4" title="Check browser permissions" :description="error" />
      <UAlert v-if="live.error" color="error" variant="subtle" class="mt-4" title="Could not connect" :description="live.error" />
    </template>
    <template #footer>
      <UButton color="neutral" variant="ghost" label="Cancel" @click="emit('update:open', false)" />
      <UButton
        :icon="kind === 'call' ? 'i-ph-phone' : 'i-ph-waveform'"
        :label="actionLabel"
        :loading="live.connection === 'connecting'"
        @click="confirm"
      />
    </template>
  </UModal>
</template>
