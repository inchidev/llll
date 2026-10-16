<script setup lang="ts">
import type { RTKParticipant, RTKSelf } from '@cloudflare/realtimekit'

const props = defineProps<{
  participant: RTKParticipant | RTKSelf
  self?: boolean
  active?: boolean
  revision: number
}>()

const video = useTemplateRef<HTMLVideoElement>('video')
const screen = useTemplateRef<HTMLVideoElement>('screen')
const participant = computed(() => props.participant as RTKParticipant & RTKSelf)
const displayName = computed(() => participant.value.name || (props.self ? 'You' : 'Participant'))

function detachVideo() {
  try { participant.value.deregisterVideoElement(video.value ?? undefined, Boolean(props.self)) }
  catch { /* SDK may already have replaced the track */ }
}

function attachVideo() {
  detachVideo()
  if (video.value && participant.value.videoEnabled) {
    participant.value.registerVideoElement(video.value, Boolean(props.self))
  }
  if (screen.value) {
    const track = participant.value.screenShareTracks?.video
    screen.value.srcObject = track ? new MediaStream([track]) : null
    if (track) void screen.value.play().catch(() => undefined)
  }
}

watch(() => [props.participant, props.revision], attachVideo, { flush: 'post' })
onMounted(attachVideo)
onUnmounted(detachVideo)
</script>

<template>
  <article
    class="group relative min-h-40 overflow-hidden rounded-xl bg-black ring-2 transition"
    :class="active ? 'ring-primary' : 'ring-transparent'"
  >
    <video
      v-if="participant.screenShareEnabled"
      ref="screen"
      autoplay
      playsinline
      class="size-full object-contain"
    />
    <video
      v-show="participant.videoEnabled && !participant.screenShareEnabled"
      ref="video"
      autoplay
      muted
      playsinline
      class="size-full object-cover"
      :class="self ? '-scale-x-100' : ''"
    />
    <div v-if="!participant.videoEnabled && !participant.screenShareEnabled" class="absolute inset-0 grid place-items-center">
      <UAvatar :src="participant.picture || undefined" :text="displayName.slice(0, 1).toUpperCase()" size="3xl" />
    </div>
    <div class="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-8 text-white">
      <span class="truncate text-sm font-medium">{{ self ? `${displayName} (you)` : displayName }}</span>
      <UIcon v-if="!participant.audioEnabled" name="i-ph-microphone-slash" class="ml-auto size-4 text-error" />
      <UBadge v-if="participant.screenShareEnabled" color="neutral" variant="solid" size="xs" label="Presenting" />
    </div>
  </article>
</template>
