import { useQueryClient } from '@tanstack/vue-query'

const HOVER_DELAY_MS = 80

/**
 * Warms a conversation's newest messages while the pointer rests on its sidebar
 * row, so opening it paints from cache instead of waiting on the network.
 */
export function useMessagePrefetch() {
  const qc = useQueryClient()
  const { api } = useApi()
  let timer: ReturnType<typeof setTimeout> | undefined

  function prefetch(channelId: string) {
    if (!channelId) return
    void qc.prefetchInfiniteQuery({
      queryKey: ['messages', channelId],
      initialPageParam: undefined as string | undefined,
      queryFn: () => api(`/api/channels/${channelId}/messages`, { query: { limit: 50 } }),
      staleTime: 15_000,
    })
  }

  function intent(channelId: string) {
    clearTimeout(timer)
    timer = setTimeout(() => prefetch(channelId), HOVER_DELAY_MS)
  }

  function cancel() {
    clearTimeout(timer)
  }

  onBeforeUnmount(cancel)
  return { prefetch, intent, cancel }
}
