<script setup lang="ts">
import type { MemberDTO } from '~~/shared/types'
import { liveInProgressLabel, liveJoinLabel } from '~~/shared/live'

const props = defineProps<{
  channelId: string
  members: MemberDTO[]
}>()

const emit = defineEmits<{
  join: []
}>()

const live = useLiveStore()
const { leave } = useLiveSession(() => props.channelId, { leaveOnUnmount: false })
const state = computed(() => live.stateFor(props.channelId))
const joinedHere = computed(() => live.connection === 'connected' && live.currentChannelId === props.channelId)
const names = computed(() => Object.fromEntries(props.members.map(member => [member.user.id, member.nickname || member.user.displayName])))
const users = computed(() => Object.fromEntries(props.members.map(member => [member.user.id, member.user])))
const { serverUrl } = useApi()
function avatarOf(id: string) {
  const user = users.value[id]
  const src = user ? userAvatarSrc(user) : undefined
  return src?.startsWith('/api/') ? serverUrl(src) : src
}
</script>

<template>
  <div class="mx-4 mb-2 flex items-center gap-3 rounded-lg border border-success/20 bg-success/5 px-3 py-2">
    <UIcon :name="state?.kind === 'call' ? 'i-ph-phone' : 'i-ph-waveform'" class="size-4 shrink-0 text-success" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-xs font-semibold text-success">
        {{ joinedHere ? 'Connected' : state?.ringing ? 'Ringing…' : liveInProgressLabel(state?.kind ?? 'live') }}
      </p>
      <UAvatarGroup v-if="state?.participantIds.length" size="3xs" class="mt-1">
        <UAvatar
          v-for="id in state.participantIds"
          :key="id"
          :src="avatarOf(id)"
          :text="(names[id] || '?').slice(0, 1).toUpperCase()"
          :alt="names[id]"
        />
      </UAvatarGroup>
    </div>
    <div class="flex items-center gap-1">
      <template v-if="joinedHere">
        <UButton color="neutral" variant="ghost" size="xs" square icon="i-ph-corners-out" aria-label="Open live session" @click="live.expanded = true" />
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          square
          :icon="live.muted ? 'i-ph-microphone-slash' : 'i-ph-microphone'"
          :aria-label="live.muted ? 'Unmute' : 'Mute'"
          @click="live.toggleMute()"
        />
        <UButton color="error" variant="soft" size="xs" icon="i-ph-phone-disconnect" :label="state?.kind === 'call' ? 'Hang up' : 'Leave'" @click="leave" />
      </template>
      <UButton v-else-if="state?.active" size="xs" :icon="state.kind === 'call' ? 'i-ph-phone' : 'i-ph-waveform'" :label="liveJoinLabel(state.kind)" @click="emit('join')" />
    </div>
    <UAlert v-if="live.error && joinedHere" color="error" :title="live.error" class="max-w-xs" />
  </div>
</template>
