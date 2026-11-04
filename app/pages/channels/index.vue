<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { ChannelCategoryDTO, ChannelDTO } from '~~/shared/types'
import { channelPath } from '~~/shared/paths'
import { chatNavigationTarget } from '~~/shared/server-navigation'

definePageMeta({ middleware: ['auth'] })
const ui = useUiStore()
const qc = useQueryClient()
const { serverId } = useServer()
const { api } = useApi()

onMounted(() => {
  let stop = () => {}
  stop = watch(serverId, async (id) => {
    if (!id) return
    const last = ui.last()
    const [channelList, dmList] = await Promise.all([
      qc.fetchQuery({
        queryKey: ['channels', id],
        queryFn: () => api<{ categories: ChannelCategoryDTO[]; channels: ChannelDTO[] }>(`/api/servers/${id}/channels`),
      }),
      qc.fetchQuery({ queryKey: ['dms'], queryFn: () => api<{ channels: ChannelDTO[] }>('/api/dms') }),
    ])
    const remembered = chatNavigationTarget([...channelList.channels, ...dmList.channels], last?.serverId === id ? last.channelId : undefined)
    if (remembered !== '/channels') {
      stop()
      await navigateTo(remembered, { replace: true })
      return
    }
    const { channels } = channelList
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
