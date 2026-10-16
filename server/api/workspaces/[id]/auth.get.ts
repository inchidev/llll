import type { AuthSettingsAdminDTO } from '../../../../shared/types'
import { authSettingsAdminDto, loadAuthRuntimeConfig } from '../../../utils/auth-config'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<{ auth: AuthSettingsAdminDTO }> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage authentication')
  const { env } = cf(event)
  return { auth: authSettingsAdminDto(await loadAuthRuntimeConfig(env, getRequestURL(event).origin)) }
})
