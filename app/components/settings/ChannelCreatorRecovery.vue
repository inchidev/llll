<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
const props = defineProps<{ serverId: string }>()
const { api } = useApi()
const toast = useToast()
const qc = useQueryClient()
const page = ref(1)
const selected = ref<{ id: string; name: string } | null>(null)
const search = ref('')
const participant = ref<string>()
const saving = ref(false)
const channels = useQuery({
  queryKey: computed(() => ['channel-creator-recovery', props.serverId, page.value]),
  queryFn: () => api<{ channels: { id: string; name: string }[]; total: number }>(`/api/servers/${props.serverId}/channels/recovery`, { query: { page: page.value } }),
})
const members = useQuery({
  queryKey: computed(() => ['channel-creator-candidates', props.serverId, selected.value?.id, search.value]),
  queryFn: () => api<{ members: { id: string; label: string }[]; hasMore: boolean }>(`/api/servers/${props.serverId}/channels/${selected.value!.id}/creator`, { query: { search: search.value } }),
  enabled: computed(() => Boolean(selected.value)),
})
function choose(channel: { id: string; name: string }) {
  selected.value = channel; participant.value = undefined; search.value = ''
}
async function assign() {
  if (!selected.value || !participant.value) return
  saving.value = true
  try {
    await api(`/api/servers/${props.serverId}/channels/${selected.value.id}/creator`, { method: 'PUT', body: { userId: participant.value } })
    selected.value = null
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['channel-creator-recovery', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['channels', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['audit', props.serverId] }),
    ])
    toast.add({ title: 'Channel creator assigned', color: 'success' })
  } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { saving.value = false }
}
</script>

<template>
  <section class="mt-10 space-y-3">
    <h2 class="text-sm font-semibold text-highlighted">Missing channel creators</h2>
    <p class="text-sm text-muted">Assign a current participant to an older private channel without a recorded creator. That person will manage its members. This action is recorded in the audit log.</p>
    <LayoutLoadError v-if="channels.error.value" message="Channels did not load." :retry="channels.refetch" />
    <ul v-else class="divide-y divide-default">
      <li v-for="channel in channels.data.value?.channels" :key="channel.id" class="flex items-center justify-between gap-3 py-2">
        <span class="min-w-0 truncate">{{ channel.name }}</span>
        <UButton label="Assign creator" size="xs" color="neutral" variant="outline" @click="choose(channel)" />
      </li>
    </ul>
    <p v-if="channels.data.value?.total === 0" class="text-sm text-muted">Every private channel has a recorded creator.</p>
    <UPagination v-if="(channels.data.value?.total ?? 0) > 25" v-model:page="page" :items-per-page="25" :total="channels.data.value?.total ?? 0" />
    <UModal :open="Boolean(selected)" title="Assign channel creator" :description="selected?.name" @update:open="value => { if (!value && !saving) selected = null }">
      <template #body>
        <p class="mb-4 text-sm text-muted">Choose a current participant. Once assigned, the creator can add or remove members.</p>
        <UInput v-model="search" placeholder="Search participants" aria-label="Search channel participants" class="mb-3 w-full" />
        <LayoutLoadError v-if="members.error.value" message="Participants did not load." :retry="members.refetch" />
        <USelect v-else v-model="participant" :items="members.data.value?.members ?? []" value-key="id" placeholder="Choose a participant" aria-label="Channel creator" class="w-full" />
        <p v-if="members.data.value?.hasMore" class="mt-2 text-sm text-muted">Search to find more participants.</p>
        <p v-if="members.data.value?.members.length === 0" class="mt-2 text-sm text-muted">No matching active participants.</p>
      </template>
      <template #footer>
        <UButton label="Cancel" color="neutral" variant="ghost" :disabled="saving" @click="selected = null" />
        <UButton label="Assign creator" :disabled="!participant || members.isPending.value || Boolean(members.error.value)" :loading="saving" @click="assign" />
      </template>
    </UModal>
  </section>
</template>
