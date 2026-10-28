import { useQuery } from '@tanstack/vue-query'
import type { ChannelDTO, MailboxDTO } from '~~/shared/types'
import { inboxAttention, unreadConversations as selectUnread, type InboxDTO } from '~~/shared/inbox'

/**
 * Everything waiting on the signed-in member. Decisions, mentions, agent work and Tasks come
 * from the Server; mail and unread chats reuse the navigation's queries and realtime updates.
 */
export function useInbox(serverId: MaybeRefOrGetter<string>) {
  const { api } = useApi()
  const enabled = computed(() => Boolean(toValue(serverId)))
  const inbox = useQuery({
    queryKey: computed(() => ['inbox', toValue(serverId)]),
    queryFn: () => api<InboxDTO>(`/api/servers/${toValue(serverId)}/inbox`),
    enabled,
    refetchInterval: 30_000,
  })
  const channels = useQuery({
    queryKey: computed(() => ['channels', toValue(serverId)]),
    queryFn: () => api<{ channels: ChannelDTO[] }>(`/api/servers/${toValue(serverId)}/channels`),
    enabled,
  })
  const dms = useQuery({ queryKey: ['dms'], queryFn: () => api<{ channels: ChannelDTO[] }>('/api/dms') })
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api<{ mailboxes: MailboxDTO[] }>('/api/mail/mailboxes') })
  const queries = [inbox, channels, dms, mailboxes]
  return {
    inbox: computed(() => inbox.data.value),
    attention: computed(() => inboxAttention(inbox.data.value)),
    unreadConversations: computed(() => selectUnread([...(channels.data.value?.channels ?? []), ...(dms.data.value?.channels ?? [])], toValue(serverId))),
    unreadMailboxes: computed(() => (mailboxes.data.value?.mailboxes ?? []).filter(mailbox => mailbox.unreadCount > 0)),
    pending: computed(() => inbox.isPending.value || channels.isPending.value || dms.isPending.value),
    error: computed(() => inbox.error.value || channels.error.value || dms.error.value),
    retryFailed: () => Promise.all(queries.filter(query => query.error.value).map(query => query.refetch())),
    refresh: () => Promise.all(queries.map(query => query.refetch())),
  }
}
