import type { PublicOnboardingConfig } from '../../../../shared/types'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { loadCurrentOnboarding } from '../../../utils/onboarding'

export default defineEventHandler(async (event): Promise<{ onboarding: PublicOnboardingConfig }> => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage onboarding')
  return { onboarding: await loadCurrentOnboarding(cf(event).env) }
})
