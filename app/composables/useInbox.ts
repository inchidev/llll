import { useQuery } from '@tanstack/vue-query'
import type { ChannelDTO } from '~~/shared/types'
import { unreadConversations as selectUnread } from '~~/shared/inbox'

/** Reuse the navigation's authorized queries and realtime read/activity updates. */
export function useInbox(serverId: MaybeRefOrGetter<string>) {
  const { api } = useApi()
  const channels = useQuery({
    queryKey: computed(() => ['channels', toValue(serverId)]),
    queryFn: () => api<{ channels: ChannelDTO[] }>(`/api/servers/${toValue(serverId)}/channels`),
    enabled: computed(() => Boolean(toValue(serverId))),
  })
  const dms = useQuery({ queryKey: ['dms'], queryFn: () => api<{ channels: ChannelDTO[] }>('/api/dms') })
  return {
    unreadConversations: computed(() => selectUnread([...(channels.data.value?.channels ?? []), ...(dms.data.value?.channels ?? [])], toValue(serverId))),
    pending: computed(() => channels.isPending.value || dms.isPending.value),
    error: computed(() => channels.error.value || dms.error.value),
    refresh: () => Promise.all([channels.refetch(), dms.refetch()]),
  }
}
