import { useQuery } from '@tanstack/vue-query'
import type { ServerDTO } from '~~/shared/types'

export function useServer() {
  const { api } = useApi()
  const serversQ = useQuery({
    queryKey: ['servers'],
    queryFn: () => api<{ servers: ServerDTO[] }>('/api/servers'),
  })
  const server = computed(() => serversQ.data.value?.servers[0] ?? null)
  // One server holds exactly one server, so its id is known before the
  // list loads; the layout can render immediately instead of popping in.
  const serverId = computed(() => server.value?.id ?? useServers().activeServer.value?.id ?? '')
  return { serversQ, server, serverId }
}
