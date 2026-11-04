import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ChatAttention } from '~~/shared/chat-attention'

export function useChatAttention(channelId: MaybeRefOrGetter<string>) {
  const { api } = useApi()
  const cache = useQueryClient()
  const toast = useToast()
  const key = computed(() => ['chat-attention', toValue(channelId)])
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<ChatAttention>(`/api/channels/${toValue(channelId)}/attention`),
    enabled: computed(() => Boolean(toValue(channelId))),
  })
  const update = useMutation({
    mutationFn: (input: Partial<Pick<ChatAttention, 'following' | 'notifications'>>) => {
      const id = toValue(channelId)
      return api<ChatAttention>(`/api/channels/${id}/attention`, { method: 'PATCH', body: input }).then(state => ({ id, state }))
    },
    onSuccess: ({ id, state }) => {
      cache.setQueryData(['chat-attention', id], state)
      for (const name of ['channels', 'dms', 'followed-threads']) void cache.invalidateQueries({ queryKey: [name] })
    },
    onError: () => toast.add({ title: 'Could not save conversation settings', color: 'error' }),
  })
  return { query, update }
}
