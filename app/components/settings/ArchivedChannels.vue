<script setup lang="ts">
import SettingsEditor from './SettingsEditor.vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ArchivedChannelDTO } from '~~/shared/types'
import { formatFullDateTime } from '~~/shared/format'

const props = defineProps<{ serverId: string }>()
const { api } = useApi()
const toast = useToast()
const qc = useQueryClient()
const session = useSessionStore()
const selected = ref<ArchivedChannelDTO | null>(null)
const restoring = ref(false)
const archived = useQuery({
  queryKey: computed(() => ['archived-channels', props.serverId]),
  queryFn: () => api<{ channels: ArchivedChannelDTO[] }>(`/api/servers/${props.serverId}/channels/archived`),
})
/** A private channel follows its visibility rule: only its creator restores it. */
function canRestore(channel: ArchivedChannelDTO) {
  return channel.visibility !== 'private' || channel.createdBy === session.user?.id
}
async function restore() {
  const channel = selected.value
  if (!channel || restoring.value) return
  restoring.value = true
  try {
    await api(`/api/channels/${channel.id}/archive`, { method: 'DELETE' })
    selected.value = null
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['archived-channels', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['channels', props.serverId] }),
      qc.invalidateQueries({ queryKey: ['channel', channel.id] }),
    ])
    toast.add({ title: `#${channel.name} restored`, color: 'success' })
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { restoring.value = false }
}
</script>

<template>
  <section class="space-y-3">
    <p class="text-sm text-muted">Archived channels are hidden from Chat and the Inbox and accept no new messages. Their history stays readable at its links and in search. Restore a channel to use it again.</p>
    <LayoutLoadError v-if="archived.error.value" message="Archived channels did not load." :retry="archived.refetch" />
    <SettingsList v-else :items="archived.data.value?.channels ?? []" :loading="archived.isPending.value" :item-key="channel => channel.id" :search-text="channel => channel.name" placeholder="Search archived channels" :noun="['channel', 'channels']" @select="selected = $event">
      <template #row="{ item: channel }">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"><UIcon :name="channel.visibility === 'private' ? 'i-ph-lock' : 'i-ph-archive'" class="size-4" /></span>
        <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium text-highlighted">{{ channel.name }}</span><span class="block truncate text-xs text-muted">Archived {{ formatFullDateTime(channel.archivedAt) }}<template v-if="channel.archivedBy"> by {{ channel.archivedBy.displayName }}</template></span></span>
      </template>
      <template #empty><p class="py-4 text-sm text-muted">No archived channels.</p></template>
    </SettingsList>
    <SettingsEditor back="Archived" :open="Boolean(selected)" :title="selected?.name || 'Archived channel'" description="Archived channel" @update:open="value => { if (!value && !restoring) selected = null }">
      <template #body>
        <p v-if="selected?.topic" class="mb-3 text-sm text-default">{{ selected.topic }}</p>
        <p class="text-sm text-muted">Restoring returns it to Chat with its history and Threads. Members can post, react and start Live rooms there again. Schedules that were blocked while it was archived can then be resumed.</p>
        <p v-if="selected && !canRestore(selected)" class="mt-3 text-sm text-muted">Only the channel creator can restore this private channel.</p>
      </template>
      <template #footer>
        <UButton label="Cancel" color="neutral" variant="ghost" :disabled="restoring" @click="selected = null" />
        <UButton label="Restore" icon="i-ph-arrow-counter-clockwise" :disabled="!selected || !canRestore(selected)" :loading="restoring" @click="restore" />
      </template>
    </SettingsEditor>
  </section>
</template>
