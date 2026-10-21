import { useQuery } from '@tanstack/vue-query'
import type { MemberDTO } from '~~/shared/types'

export function useRoleGrants() {
  const { serverId } = useServer()
  const { api } = useApi()
  const members = useQuery({ queryKey: computed(() => ['members', serverId.value]),
    queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${serverId.value}/members`), enabled: computed(() => Boolean(serverId.value)) })
  return usePermissions(computed(() => members.data.value?.members))
}
