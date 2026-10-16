<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { ChannelDTO, MemberDTO, PublicUser } from '~~/shared/types'
import { channelPath } from '~~/shared/paths'

const props = defineProps<{
  user: PublicUser
  member?: MemberDTO
}>()
const emit = defineEmits<{ close: [] }>()

const session = useSessionStore()
const presence = usePresenceStore()
const toast = useToast()
const qc = useQueryClient()
const { api } = useApi()
const { workspaceId } = useWorkspace()
const note = ref('')
const opening = ref(false)
const isMe = computed(() => props.user.id === session.user?.id)
const status = computed(() => presence.statusOf(props.user.id))
const statusLabel = computed(() => ({ online: 'Online', idle: 'Idle', offline: 'Offline' } as Record<string, string>)[status.value] ?? 'Offline')
const roleName = computed(() => {
  const name = props.member?.role.name
  if (!name) return null
  if (name === 'owner') return 'Owner'
  if (name === 'admin') return 'Admin'
  if (name === 'member') return 'Member'
  return name
})

async function openDm() {
  if (isMe.value || props.user.kind === 'agent' || opening.value) return
  opening.value = true
  try {
    const res = await api<{ channel: ChannelDTO }>('/api/dms', { method: 'POST', body: { userId: props.user.id, workspaceId: workspaceId.value } })
    await qc.invalidateQueries({ queryKey: ['dms'] })
    const text = note.value.trim()
    if (text) useUiStore().setComposerDraft(res.channel.id, text)
    emit('close')
    await navigateTo(channelPath(res.channel))
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    opening.value = false
  }
}
</script>

<template>
  <div class="w-72 overflow-hidden">
    <div class="h-14 bg-primary/25" />
    <div class="-mt-8 px-4 pb-4">
      <div class="relative w-fit rounded-full ring-4 ring-(--ui-bg)">
        <UserAvatar :user="user" size="3xl" />
        <span
          class="absolute bottom-0.5 end-0.5 size-4 rounded-full ring-3 ring-(--ui-bg)"
          :class="status === 'online' ? 'bg-success' : status === 'idle' ? 'bg-warning' : 'bg-dimmed'"
          :aria-label="statusLabel"
        />
      </div>
      <div class="mt-2">
        <p class="truncate text-lg font-semibold leading-tight text-highlighted">{{ member?.nickname || user.displayName }}</p>
        <p v-if="member?.nickname" class="truncate text-sm text-muted">{{ user.displayName }}</p>
      </div>
      <div class="mt-3 flex flex-wrap gap-1.5">
        <UBadge v-if="user.kind === 'agent'" label="AI agent" color="primary" variant="subtle" size="sm" />
        <UBadge v-if="roleName" :label="roleName" color="neutral" variant="subtle" size="sm" />
        <UBadge :label="statusLabel" color="neutral" variant="outline" size="sm" />
      </div>
      <form v-if="!isMe && user.kind !== 'agent'" class="mt-4" @submit.prevent="openDm">
        <UInput
          v-model="note"
          size="sm"
          class="w-full"
          :placeholder="`Message @${member?.nickname || user.displayName}`"
          :loading="opening"
          :aria-label="`Message ${user.displayName}`"
        />
      </form>
    </div>
  </div>
</template>
