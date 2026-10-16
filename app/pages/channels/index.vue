<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { ChannelCategoryDTO, ChannelDTO } from '~~/shared/types'
import { channelPath } from '~~/shared/paths'

definePageMeta({ middleware: ['auth'] })
const ui = useUiStore()
const qc = useQueryClient()
const { workspaceId } = useWorkspace()
const { api } = useApi()

onMounted(() => {
  let stop = () => {}
  stop = watch(workspaceId, async (id) => {
    if (!id) return
    const last = ui.last()
    if (last?.channelId) {
      stop()
      await navigateTo(`/channels/${last.channelId}`, { replace: true })
      return
    }
    // Same query the navigation uses, so the list is fetched once.
    const { channels } = await qc.fetchQuery({
      queryKey: ['channels', id],
      queryFn: () => api<{ categories: ChannelCategoryDTO[]; channels: ChannelDTO[] }>(`/api/workspaces/${id}/channels`),
    })
    const first = channels.find((c) => c.type === 'text') ?? channels[0]
    if (first) {
      stop()
      await navigateTo(channelPath(first), { replace: true })
    }
  }, { immediate: true })
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <LayoutPageHeader icon="i-ph-hash" loading />
    <LayoutSkeleton variant="messages" class="min-h-0 flex-1" />
  </div>
</template>
