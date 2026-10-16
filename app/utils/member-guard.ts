import { WORKSPACE_ID } from '~~/shared/ids'
import { hasPermission, type PermissionFlag } from '~~/shared/permissions'
import type { MemberDTO } from '~~/shared/types'

/**
 * Route guard shared by the permission middlewares: the signed-in member must be
 * the owner or hold at least one of `flags`. On the client it reads the same
 * `members` query the app already keeps, so navigating between guarded pages
 * (or settings sections) does not refetch the member list.
 */
export async function guardMemberPermission(flags: PermissionFlag[]) {
  const session = useSessionStore()
  if (!session.user) return

  const { api, native } = useApi()
  const requestFetch = useRequestFetch()
  const url = `/api/workspaces/${WORKSPACE_ID}/members`
  const load = (): Promise<{ members: MemberDTO[] }> => import.meta.client && native
    ? api<{ members: MemberDTO[] }>(url)
    : requestFetch<{ members: MemberDTO[] }>(url)
  const response = import.meta.client
    ? await useNuxtApp().$queryClient.ensureQueryData({ queryKey: ['members', WORKSPACE_ID], queryFn: load })
    : await load()

  const member = response.members.find(item => item.user.id === session.user?.id)
  if (!member || (member.role.key !== 'owner' && !flags.some(flag => hasPermission(member.role.permissions, flag)))) {
    return navigateTo('/channels')
  }
}
