import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { users } from '../../../drizzle/schema'
import { activateOpenMember, requireUser, sessionUser } from '../../utils/auth'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { recordOnboardingAcceptance, requireCurrentOnboardingAcceptance } from '../../utils/onboarding'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  accepted: z.literal(true),
  onboardingRevisionId: z.string().min(1).max(100),
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const onboarding = await requireCurrentOnboardingAcceptance(env, body.onboardingRevisionId, body.accepted)
  if (!onboarding.revisionId) fail(400, 'acceptance_unavailable', 'There are no published documents to accept')
  await recordOnboardingAcceptance(env, user.id, onboarding.revisionId)
  await activateOpenMember(event, user.id)
  const row = (await getDb(env.DB).select().from(users).where(eq(users.id, user.id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'User not found')
  return { user: await sessionUser(event, row, user.email) }
})
