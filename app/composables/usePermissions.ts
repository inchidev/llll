import { hasPermission, type PermissionFlag } from '~~/shared/permissions'
import type { MemberDTO } from '~~/shared/types'
import { projectSubjectPermissionAllowed } from '~~/shared/project-access'

export function usePermissions(members: MaybeRefOrGetter<MemberDTO[] | undefined>) {
  const session = useSessionStore()
  const mine = computed(() => {
    const list = toValue(members) ?? []
    return list.find((m) => m.user.id === session.user?.id) ?? null
  })
  function can(flag: PermissionFlag, projectId?: string | null) {
    if (projectId && mine.value) return projectSubjectPermissionAllowed({ ...mine.value.role, roleId: mine.value.role.id, roleName: mine.value.role.name, id: mine.value.user.id, kind: mine.value.user.kind, isOwner: mine.value.role.key === 'owner', projectPolicies: mine.value.projectPolicies }, projectId, flag)
    return mine.value ? hasPermission(mine.value.role.permissions, flag) : false
  }
  function canAnyProject(flag: PermissionFlag) { return can(flag) || Boolean(mine.value?.projectPolicies?.some(grant => can(flag, grant.projectId))) }
  return { mine, can, canAnyProject }
}
