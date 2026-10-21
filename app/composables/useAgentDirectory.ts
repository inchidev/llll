import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ChannelDTO, MemberDTO } from '~~/shared/types'
import { channelPath } from '~~/shared/paths'

/** Public Member profiles; management instructions never enter the directory. */
export function useAgentDirectory(serverId: () => string) {
  const { api } = useApi()
  const qc = useQueryClient()
  const toast = useToast()
  const opening = useState<string | null>('agents:opening-dm', () => null)
  const members = useQuery({
    queryKey: computed(() => ['members', serverId()]),
    queryFn: () => api<{ members: MemberDTO[] }>(`/api/servers/${serverId()}/members`),
    enabled: computed(() => Boolean(serverId())),
  })
  const agents = computed(() => (members.data.value?.members ?? []).filter(member => member.user.kind === 'agent'))
  async function messageAgent(userId: string) {
    if (opening.value) return
    opening.value = userId
    try {
      const result = await api<{ channel: ChannelDTO }>('/api/dms', { method: 'POST', body: { userId, serverId: serverId() } })
      await qc.invalidateQueries({ queryKey: ['dms'] })
      await navigateTo(channelPath(result.channel))
    } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
    finally { opening.value = null }
  }
  return { agents, members, messageAgent, opening }
}
