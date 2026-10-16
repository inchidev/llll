<script setup lang="ts">
import { liveTitle } from '~~/shared/live'

defineProps<{
  canEnd: boolean
}>()

const emit = defineEmits<{
  leave: []
  end: []
}>()

const live = useLiveStore()
const participants = computed(() => [
  ...(live.selfParticipant ? [{ participant: live.selfParticipant, self: true }] : []),
  ...live.remoteParticipants.map(participant => ({ participant, self: false })),
])
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col bg-elevated/40">
    <header class="flex h-12 shrink-0 items-center gap-3 border-b border-default px-4">
      <div class="grid size-8 place-items-center rounded-lg bg-success/15 text-success">
        <UIcon :name="live.currentKind === 'call' ? 'i-ph-phone' : 'i-ph-waveform'" class="size-4" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold text-highlighted">{{ live.currentTitle || liveTitle(live.currentKind) }}</p>
        <p class="text-xs text-muted">{{ participants.length }} {{ participants.length === 1 ? 'participant' : 'participants' }}</p>
      </div>
      <UButton icon="i-ph-corners-in" color="neutral" variant="ghost" square aria-label="Minimize live session" @click="live.expanded = false" />
    </header>

    <div class="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-2 overflow-y-auto p-3 sm:grid-cols-2 xl:grid-cols-3">
      <LiveVideoTile
        v-for="item in participants"
        :key="item.self ? 'self' : item.participant.id"
        :participant="item.participant"
        :self="item.self"
        :active="!item.self && live.activeSpeakerId === item.participant.id"
        :revision="live.mediaRevision"
      />
    </div>

    <UAlert v-if="live.error" color="error" variant="subtle" class="mx-3 mb-2 shrink-0" title="Live connection problem" :description="live.error" />

    <footer class="flex shrink-0 items-center justify-center gap-2 border-t border-default bg-default/95 px-3 py-3">
      <UTooltip :text="live.muted ? 'Unmute' : 'Mute'">
        <UButton
          square
          size="lg"
          :icon="live.muted ? 'i-ph-microphone-slash' : 'i-ph-microphone'"
          :color="live.muted ? 'error' : 'neutral'"
          :variant="live.muted ? 'soft' : 'outline'"
          :aria-pressed="live.muted"
          @click="live.toggleMute()"
        />
      </UTooltip>
      <UTooltip :text="live.camera ? 'Turn camera off' : 'Turn camera on'">
        <UButton
          square
          size="lg"
          :icon="live.camera ? 'i-ph-video-camera' : 'i-ph-video-camera-slash'"
          :color="live.camera ? 'primary' : 'neutral'"
          :variant="live.camera ? 'soft' : 'outline'"
          :aria-pressed="live.camera"
          @click="live.toggleCamera()"
        />
      </UTooltip>
      <UTooltip :text="live.deafened ? 'Undeafen' : 'Deafen'">
        <UButton
          square
          size="lg"
          :icon="live.deafened ? 'i-ph-headphones-slash' : 'i-ph-headphones'"
          :color="live.deafened ? 'error' : 'neutral'"
          :variant="live.deafened ? 'soft' : 'outline'"
          :aria-pressed="live.deafened"
          @click="live.toggleDeafen()"
        />
      </UTooltip>
      <UTooltip :text="live.screenSharing ? 'Stop sharing' : 'Share screen'">
        <UButton
          square
          size="lg"
          icon="i-ph-monitor-arrow-up"
          :color="live.screenSharing ? 'primary' : 'neutral'"
          :variant="live.screenSharing ? 'soft' : 'outline'"
          :aria-pressed="live.screenSharing"
          @click="live.toggleScreenShare()"
        />
      </UTooltip>
      <UButton color="error" size="lg" icon="i-ph-phone-disconnect" :label="live.currentKind === 'call' ? 'Hang up' : 'Leave'" @click="emit('leave')" />
      <UDropdownMenu
        v-if="canEnd && live.currentKind !== 'call'"
        :items="[[{ label: 'End for everyone', icon: 'i-ph-x-circle', color: 'error', onSelect: () => emit('end') }]]"
      >
        <UButton color="neutral" variant="ghost" square icon="i-ph-dots-three-vertical" aria-label="Live session actions" />
      </UDropdownMenu>
    </footer>
  </section>
</template>
