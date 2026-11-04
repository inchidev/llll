import type { PublicOnboardingConfig } from '../../shared/types'
import { cf } from '../utils/cf'
import { ensureMigrated } from '../utils/db'
import { loadCurrentOnboarding } from '../utils/onboarding'

export default defineEventHandler(async (event): Promise<{ onboarding: PublicOnboardingConfig }> => {
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  return { onboarding: await loadCurrentOnboarding(env) }
})
