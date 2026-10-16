import { eq } from 'drizzle-orm'
import { channels, invites, roles, users } from '../../../../drizzle/schema'
import { nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { requireUser } from '../../../utils/auth'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'
import { signalMembersChanged } from '../../../../workers/member-events'
import { hasAcceptedCurrentOnboarding } from '../../../utils/onboarding'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')!
  const user = await requireUser(event)
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const invite = (await db.select().from(invites).where(eq(invites.code, code)).limit(1))[0]
  if (!invite) fail(404, 'not_found', 'Invite not found')
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) fail(410, 'expired', 'Invite expired')
  if (invite.maxUses > 0 && invite.uses >= invite.maxUses) fail(410, 'exhausted', 'Invite already used')

  const existing = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0]
  if (existing?.status !== 'active') {
    if (!(await hasAcceptedCurrentOnboarding(env, user.id))) {
      fail(403, 'acceptance_required', 'Accept the published workspace documents before joining')
    }
    const memberRole = (await db.select().from(roles).where(eq(roles.key, 'member')).limit(1))[0]
    if (!memberRole) fail(500, 'internal', 'Member role missing')
    await db.update(users).set({
      status: 'active',
      roleId: memberRole.id,
      joinedAt: nowIso(),
      nickname: null,
      updatedAt: nowIso(),
    }).where(eq(users.id, user.id))
    await db.update(invites).set({ uses: invite.uses + 1 }).where(eq(invites.code, code))
    await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: user.id, action: 'member.join', targetType: 'user', targetId: user.id })
    waitUntil(signalMembersChanged(env, WORKSPACE_ID))
  }

  const general = (await db.select().from(channels).where(eq(channels.name, 'general')).limit(1))[0]
  const first = general ?? (await db.select().from(channels).limit(1))[0]
  return { workspaceId: WORKSPACE_ID, channelId: first?.id ?? null }
})
