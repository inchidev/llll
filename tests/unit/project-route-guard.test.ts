import { afterEach, expect, it, vi } from 'vitest'
import { Permission } from '../../shared/permissions'
import { guardMemberPermission } from '../../app/utils/member-guard'

afterEach(() => vi.unstubAllGlobals())
it('admits scoped task readers without admitting them to Server settings', async () => {
  const member = { user: { id: 'member' }, role: { key: 'member', permissions: 0 }, projectPolicies: [{ projectId: 'A', permissions: Permission.readTasks }] }
  const load = vi.fn(async () => ({ members: [member] })), navigate = vi.fn()
  vi.stubGlobal('useSessionStore', () => ({ user: { id: 'member' } }))
  vi.stubGlobal('useApi', () => ({ native: false }))
  vi.stubGlobal('useRequestFetch', () => load)
  vi.stubGlobal('useServers', () => ({ activeServer: { value: { id: 'server' } } }))
  vi.stubGlobal('useNuxtApp', () => ({ $queryClient: { ensureQueryData: ({ queryFn }: { queryFn: typeof load }) => queryFn() } }))
  vi.stubGlobal('navigateTo', navigate)
  await guardMemberPermission([Permission.readTasks], true)
  expect(navigate).not.toHaveBeenCalled()
  await guardMemberPermission([Permission.manageRoles])
  expect(navigate).toHaveBeenCalledWith('/channels')
})
