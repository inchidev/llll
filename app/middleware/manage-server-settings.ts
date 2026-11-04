import { Permission } from '~~/shared/permissions'
import type { SpaceDTO } from '~~/shared/spaces'

export default defineNuxtRouteMiddleware(async () => {
  // A Space admin may hold no Role permission and still manage their own Space.
  const serverId = useServers().activeServer.value?.id
  if (useSessionStore().user && serverId) {
    const { api } = useApi()
    const url = `/api/servers/${serverId}/spaces`
    const list = await useNuxtApp().$queryClient.ensureQueryData({ queryKey: ['spaces', serverId], queryFn: () => api<{ spaces: SpaceDTO[] }>(url) }).catch(() => null)
    if (list?.spaces.some(space => space.role === 'admin')) return
  }
  return guardMemberPermission([
    Permission.manageServer,
    Permission.manageAgents,
    Permission.useAgents,
    Permission.useExternalTools,
    Permission.manageChannels,
    Permission.manageRoles,
    Permission.invite,
    Permission.kick,
  ])
})
