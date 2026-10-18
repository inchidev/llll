import { useQuery } from '@tanstack/vue-query'
import type { WorkspaceDTO } from '~~/shared/types'

export function useWorkspace() {
  const { api } = useApi()
  const workspacesQ = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api<{ workspaces: WorkspaceDTO[] }>('/api/workspaces'),
  })
  const workspace = computed(() => workspacesQ.data.value?.workspaces[0] ?? null)
  // One installation holds exactly one workspace, so its id is known before the
  // list loads; the layout can render immediately instead of popping in.
  const workspaceId = computed(() => workspace.value?.id ?? useServers().activeServer.value?.id ?? '')
  return { workspacesQ, workspace, workspaceId }
}
