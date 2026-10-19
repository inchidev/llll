import { useQuery } from '@tanstack/vue-query'
import type { ServerDTO } from '~~/shared/types'

export function useServer() {
  const { api } = useApi()
  const serverQ = useQuery({
    queryKey: ['server'],
    queryFn: () => api<{ server: ServerDTO }>('/api/server'),
  })
  const server = computed(() => serverQ.data.value?.server ?? null)
  // Discovery supplies the ID while the authenticated Server metadata loads.
  const serverId = computed(() => server.value?.id ?? useServers().activeServer.value?.id ?? '')
  return { serverQ, server, serverId }
}
