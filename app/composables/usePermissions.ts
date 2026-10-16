import { hasPermission, type PermissionFlag } from '~~/shared/permissions'
import type { MemberDTO } from '~~/shared/types'

export function usePermissions(members: MaybeRefOrGetter<MemberDTO[] | undefined>) {
  const session = useSessionStore()
  const mine = computed(() => {
    const list = toValue(members) ?? []
    return list.find((m) => m.user.id === session.user?.id) ?? null
  })
  function can(flag: PermissionFlag) {
    return mine.value ? hasPermission(mine.value.role.permissions, flag) : false
  }
  return { mine, can }
}
