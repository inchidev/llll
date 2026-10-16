<script setup lang="ts">
const session = useSessionStore()
const presence = usePresenceStore()
const live = useLiveStore()

const settingsOpen = ref(false)

const status = computed(() => {
  const id = session.user?.id
  return id ? presence.statusOf(id) : 'offline'
})

const chipColor = computed(() => {
  if (status.value === 'online') return 'success' as const
  if (status.value === 'idle') return 'warning' as const
  return 'neutral' as const
})

const statusLabel = computed(() => {
  if (live.connection === 'connected') return live.muted ? 'Muted' : live.currentKind === 'call' ? 'In a call' : 'Live'
  if (status.value === 'online') return 'Online'
  if (status.value === 'idle') return 'Idle'
  return 'Offline'
})

</script>

<template>
  <div class="px-2 pt-2 pb-6 shrink-0">
    <div class="df-panel flex h-11 items-center gap-0.5 rounded-lg px-1">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-start hover:bg-elevated/80 focus-visible:outline-2 focus-visible:outline-primary"
        @click="settingsOpen = true"
      >
        <UChip inset :color="chipColor" position="bottom-right" size="sm">
          <UserAvatar v-if="session.user" :user="session.user" size="sm" />
        </UChip>
        <span class="min-w-0 flex-1 leading-tight">
          <span class="block text-sm font-semibold text-highlighted truncate">{{ session.user?.displayName }}</span>
          <span class="block text-[11px] text-muted truncate">{{ statusLabel }}</span>
        </span>
      </button>
      <UTooltip :text="live.muted ? 'Unmute' : 'Mute'">
        <UButton
          :icon="live.muted ? 'i-ph-microphone-slash' : 'i-ph-microphone'"
          :color="live.muted ? 'error' : 'neutral'"
          variant="ghost"
          size="sm"
          square
          :aria-pressed="live.muted"
          :aria-label="live.muted ? 'Unmute' : 'Mute'"
          @click="live.toggleMute()"
        />
      </UTooltip>
      <UTooltip :text="live.deafened ? 'Undeafen' : 'Deafen'">
        <UButton
          :icon="live.deafened ? 'i-ph-speaker-slash' : 'i-ph-headphones'"
          :color="live.deafened ? 'error' : 'neutral'"
          variant="ghost"
          size="sm"
          square
          :aria-pressed="live.deafened"
          :aria-label="live.deafened ? 'Undeafen' : 'Deafen'"
          @click="live.toggleDeafen()"
        />
      </UTooltip>
      <UTooltip text="User settings">
        <UButton
          icon="i-ph-gear"
          color="neutral"
          variant="ghost"
          size="sm"
          square
          aria-label="User settings"
          @click="settingsOpen = true"
        />
      </UTooltip>

      <SettingsUserSettings v-model:open="settingsOpen" />
    </div>
  </div>
</template>
