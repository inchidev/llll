<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { MemberDTO, PrivateChannelMemberDTO, PublicUser } from '~~/shared/types'

const props = defineProps<{ serverId: string; channel: { id: string; name: string } }>()
const open = defineModel<boolean>('open', { default: false })
const { api } = useApi()
const session = useSessionStore()
const toast = useToast()
const cache = useQueryClient()
const search = ref('')
const busy = ref(false)
const removal = ref<PublicUser | null>(null)
const membership = useQuery({
  queryKey: computed(() => ['private-channel-members', props.channel.id]),
  queryFn: () => api<{ members: PrivateChannelMemberDTO[] }>(`/api/channels/${props.channel.id}/members`),
  enabled: computed(() => open.value),
})
const serverMembers = useQuery({
  queryKey: computed(() => ['members', props.serverId]),
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${props.serverId}/members`),
  enabled: computed(() => open.value),
})
const participants = computed(() => membership.data.value?.members ?? [])
const candidates = computed(() => {
  const joined = new Set(participants.value.map(member => member.user.id))
  const query = search.value.trim().toLowerCase()
  return (serverMembers.data.value?.members ?? []).filter(member => !joined.has(member.user.id)
    && member.user.displayName.toLowerCase().includes(query)).slice(0, 20)
})
watch(open, value => { if (!value) { search.value = ''; removal.value = null } })

async function update(userId: string, method: 'POST' | 'DELETE') {
  if (busy.value) return
  busy.value = true
  const channelId = props.channel.id
  try {
    const result = await api<{ members: PrivateChannelMemberDTO[] }>(`/api/channels/${channelId}/members${method === 'DELETE' ? `/${userId}` : ''}`, {
      method, ...(method === 'POST' ? { body: { userId } } : {}),
    })
    cache.setQueryData(['private-channel-members', channelId], result)
    removal.value = null
    toast.add({ title: method === 'POST' ? 'Member added' : 'Member removed', color: 'success' })
  } catch (error) {
    toast.add({ title: 'Could not update channel members', description: errorMessage(error), color: 'error' })
  } finally {
    await cache.invalidateQueries({ queryKey: ['private-channel-members', channelId] })
    await cache.invalidateQueries({ queryKey: ['channels', props.serverId] })
    busy.value = false
  }
}
</script>

<template>
  <SettingsEditor v-model:open="open" back="Channels" :title="`Members of #${channel.name}`" description="Members can read this channel’s history, files and Threads.">
    <template #body>
      <LayoutLoadError v-if="membership.isError.value" message="Channel members did not load." :retry="membership.refetch" />
      <div v-else-if="membership.isPending.value" class="py-6 text-sm text-muted" role="status">Loading members…</div>
      <div v-else class="space-y-5">
        <ul class="max-h-64 overflow-y-auto divide-y divide-default" aria-label="Channel members">
          <li v-for="member in participants" :key="member.user.id" class="flex items-center gap-3 py-2">
            <UserAvatar :user="member.user" class="shrink-0" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-highlighted">{{ member.user.displayName }}</span>
              <span v-if="member.status !== 'active'" class="text-xs text-muted">Inactive member</span>
              <span v-else-if="member.user.kind === 'agent'" class="text-xs text-muted">Agent</span>
            </span>
            <span v-if="member.user.id === session.user?.id" class="text-xs text-muted">You</span>
            <UButton v-else label="Remove" :aria-label="`Remove ${member.user.displayName}`" color="error" variant="ghost" size="xs" :disabled="busy" @click="removal = member.user" />
          </li>
        </ul>
        <div class="space-y-2">
          <UFormField label="Add a Server member" description="Only people added here can open this private channel.">
            <UInput v-model="search" icon="i-ph-magnifying-glass" placeholder="Find a member" class="w-full" :disabled="busy" />
          </UFormField>
          <LayoutLoadError v-if="serverMembers.isError.value" message="Server members did not load." :retry="serverMembers.refetch" />
          <div v-else-if="serverMembers.isPending.value" class="text-sm text-muted" role="status">Loading Server members…</div>
          <ul v-else class="max-h-48 overflow-y-auto" aria-label="Members to add">
            <li v-for="member in candidates" :key="member.user.id" class="flex items-center gap-3 py-2">
              <UserAvatar :user="member.user" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate text-sm">{{ member.user.displayName }}</span>
              <UButton label="Add" :aria-label="`Add ${member.user.displayName}`" size="xs" variant="soft" :disabled="busy" @click="update(member.user.id, 'POST')" />
            </li>
            <li v-if="!candidates.length" class="py-2 text-sm text-muted">No members to add.</li>
          </ul>
        </div>
      </div>
    </template>
  </SettingsEditor>
  <UModal :open="Boolean(removal)" :title="`Remove ${removal?.displayName ?? 'member'}?`" :description="`They will lose access to #${channel.name}, its files, Threads and active calls.`" @update:open="value => { if (!value && !busy) removal = null }">
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="outline" :disabled="busy" @click="removal = null" />
      <UButton label="Remove member" color="error" :loading="busy" @click="removal && update(removal.id, 'DELETE')" />
    </template>
  </UModal>
</template>
