<script setup lang="ts">
import type { RTKParticipant, RTKSelf } from '@cloudflare/realtimekit'

const props = defineProps<{
  participant: RTKParticipant | RTKSelf
  self?: boolean
  active?: boolean
  /** Changes only when this participant's media changes. */
  revision: number
  canMute?: boolean
  canRemove?: boolean
}>()

const emit = defineEmits<{
  mute: []
  remove: []
}>()

const video = useTemplateRef<HTMLVideoElement>('video')
const screen = useTemplateRef<HTMLVideoElement>('screen')
const participant = computed(() => props.participant as RTKParticipant & RTKSelf)
const displayName = computed(() => participant.value.name || (props.self ? 'You' : 'Participant'))
const hostActions = computed(() => [[
  ...(props.canMute && participant.value.audioEnabled
    ? [{ label: 'Mute for everyone', icon: 'i-ph-microphone-slash', onSelect: () => emit('mute') }]
    : []),
  ...(props.canRemove
    ? [{ label: 'Remove from live session', icon: 'i-ph-user-minus', color: 'error' as const, onSelect: () => emit('remove') }]
    : []),
]].filter(group => group.length))

// What is attached now, so an unrelated update does not re-register the same track.
let attachedVideo: { element: HTMLVideoElement, track: MediaStreamTrack | undefined } | null = null
let attachedScreen: MediaStreamTrack | null = null

function detachVideo() {
  if (!attachedVideo) return
  try { participant.value.deregisterVideoElement(attachedVideo.element, Boolean(props.self)) }
  catch { /* SDK may already have replaced the track */ }
  attachedVideo = null
}

function attachVideo() {
  const element = video.value
  const track = participant.value.videoEnabled ? participant.value.videoTrack : undefined
  if (!element || !track) detachVideo()
  else if (attachedVideo?.element !== element || attachedVideo.track !== track) {
    detachVideo()
    participant.value.registerVideoElement(element, Boolean(props.self))
    attachedVideo = { element, track }
  }
  const shared = participant.value.screenShareEnabled ? participant.value.screenShareTracks?.video ?? null : null
  if (!screen.value) attachedScreen = null
  else if (shared !== attachedScreen) {
    screen.value.srcObject = shared ? new MediaStream([shared]) : null
    attachedScreen = shared
    if (shared) void screen.value.play().catch(() => undefined)
  }
}

watch(() => props.participant, () => {
  detachVideo()
  attachedScreen = null
})
watch(() => [props.participant, props.revision], attachVideo, { flush: 'post' })
onMounted(attachVideo)
onUnmounted(detachVideo)
</script>

<template>
  <article
    class="group relative min-h-40 overflow-hidden rounded-xl bg-black ring-2 transition"
    :class="active ? 'ring-primary' : 'ring-transparent'"
    :aria-label="self ? `${displayName} (you)` : displayName"
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
      <UIcon v-if="!participant.audioEnabled" name="i-ph-microphone-slash" class="ml-auto size-4 text-error" aria-label="Muted" />
      <UBadge v-if="participant.screenShareEnabled" color="neutral" variant="solid" size="xs" label="Presenting" />
    </div>
    <UDropdownMenu v-if="hostActions.length" :items="hostActions">
      <UButton
        class="absolute right-2 top-2 opacity-80 group-hover:opacity-100 focus-visible:opacity-100"
        color="neutral"
        variant="solid"
        size="xs"
        square
        icon="i-ph-dots-three"
        :aria-label="`Host actions for ${displayName}`"
      />
    </UDropdownMenu>
  </article>
</template>
