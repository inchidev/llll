import { onboardingRevisions } from '../../../../drizzle/schema'
import { newId, nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import type { PublicOnboardingConfig } from '../../../../shared/types'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { loadCurrentOnboarding, validateRichTextDocument } from '../../../utils/onboarding'
import { writeAudit } from '../../../utils/messages'

export default defineEventHandler(async (event): Promise<{ onboarding: PublicOnboardingConfig }> => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage onboarding')
  const body = await readBody(event) as Record<string, unknown> | null
  const privacy = validateRichTextDocument(body?.privacy, 'Privacy policy')
  const terms = validateRichTextDocument(body?.terms, 'Terms of service')
  const rules = validateRichTextDocument(body?.rules, 'Workspace rules')
  const { env } = cf(event)
  const current = await loadCurrentOnboarding(env)
  const serialized = {
    privacy: JSON.stringify(privacy),
    terms: JSON.stringify(terms),
    rules: JSON.stringify(rules),
  }
  const currentSerialized = {
    privacy: JSON.stringify(current.privacy ?? { type: 'doc', content: [{ type: 'paragraph' }] }),
    terms: JSON.stringify(current.terms ?? { type: 'doc', content: [{ type: 'paragraph' }] }),
    rules: JSON.stringify(current.rules ?? { type: 'doc', content: [{ type: 'paragraph' }] }),
  }
  if (serialized.privacy === currentSerialized.privacy
    && serialized.terms === currentSerialized.terms
    && serialized.rules === currentSerialized.rules) {
    return { onboarding: current }
  }

  const revisionId = newId()
  const createdAt = nowIso()
  await getDb(env.DB).insert(onboardingRevisions).values({
    id: revisionId,
    version: current.version + 1,
    privacyJson: serialized.privacy,
    termsJson: serialized.terms,
    rulesJson: serialized.rules,
    createdBy: member.user.id,
    createdAt,
  })
  await writeAudit(env, {
    workspaceId: WORKSPACE_ID,
    actorId: member.user.id,
    action: 'onboarding.publish',
    targetType: 'onboarding_revision',
    targetId: revisionId,
    meta: { version: current.version + 1 },
  })
  return { onboarding: await loadCurrentOnboarding(env) }
})
