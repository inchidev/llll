import { getServerId } from '../../../../shared/server-id'
import { and, eq, sql } from 'drizzle-orm'
import { channels, invites, roles, spaceMembers, users } from '../../../../drizzle/schema'
import { DEFAULT_SPACE_ID } from '../../../../shared/spaces'
import { requireMemberQuota } from '../../../utils/space-quota'
import { newId, nowIso } from '../../../../shared/ids'
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
  if (await env.DB.prepare('SELECT 1 AS ok FROM spaces WHERE id = ? AND suspended_at IS NOT NULL').bind(invite.spaceId).first()) fail(403, 'space_suspended', 'This Space is suspended, so its invites do not work for now')

  const existing = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0]
  const inSpace = existing ? (await db.select({ userId: spaceMembers.userId }).from(spaceMembers).where(and(eq(spaceMembers.spaceId, invite.spaceId), eq(spaceMembers.userId, user.id))).limit(1))[0] : null
  if (!inSpace) await requireMemberQuota(env, invite.spaceId, 'human')
  if (existing?.status !== 'active') {
    if (!(await hasAcceptedCurrentOnboarding(env, user.id))) {
      fail(403, 'acceptance_required', 'Accept the published server documents before joining')
    }
    const memberRole = (await db.select().from(roles).where(eq(roles.key, 'member')).limit(1))[0]
    if (!memberRole) fail(500, 'internal', 'Member role missing')
    // Activation joins the default Space by trigger; an invite to another Space replaces that, atomically.
    await db.batch([
      db.update(users).set({
        status: 'active',
        roleId: memberRole.id,
        joinedAt: nowIso(),
        nickname: null,
        updatedAt: nowIso(),
      }).where(eq(users.id, user.id)),
      db.insert(spaceMembers).values({ spaceId: invite.spaceId, userId: user.id, joinedAt: nowIso() }).onConflictDoNothing(),
      db.delete(spaceMembers).where(and(eq(spaceMembers.userId, user.id), eq(spaceMembers.spaceId, DEFAULT_SPACE_ID), sql`${invite.spaceId} <> ${DEFAULT_SPACE_ID}`)),
    ])
    await db.update(invites).set({ uses: invite.uses + 1 }).where(eq(invites.code, code))
    await writeAudit(env, { serverId: (await getServerId(cf(event).env.DB)), actorId: user.id, action: 'member.join', targetType: 'user', targetId: user.id })
    waitUntil(signalMembersChanged(env, (await getServerId(cf(event).env.DB))))
  }
  else if (!inSpace) {
    // Already a Member of the Server: the invite adds this Space to the ones they have.
    await db.insert(spaceMembers).values({ spaceId: invite.spaceId, userId: user.id, joinedAt: nowIso() }).onConflictDoNothing()
    await db.update(invites).set({ uses: invite.uses + 1 }).where(eq(invites.code, code))
    await writeAudit(env, { serverId: (await getServerId(cf(event).env.DB)), actorId: user.id, action: 'space.member.add', targetType: 'space', targetId: invite.spaceId, meta: { userId: user.id, invite: true } })
    waitUntil(signalMembersChanged(env, (await getServerId(cf(event).env.DB))))
  }

  // A Project invite: joining and being able to act there are one step. Its creator was checked when it was made.
  if (invite.projectId && invite.policyId) {
    const now = nowIso()
    await env.DB.prepare(`INSERT INTO grants(id,project_id,policy_id,member_id,created_by,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM projects WHERE id=? AND archived_at IS NULL) ON CONFLICT DO NOTHING`)
      .bind(newId(), invite.projectId, invite.policyId, user.id, invite.creatorId, now, invite.projectId).run()
    await writeAudit(env, { serverId: await getServerId(env.DB), actorId: user.id, action: 'project.access.invite', targetType: 'project', targetId: invite.projectId, meta: { policyId: invite.policyId, invite: code } })
  }

  const inInvitedSpace = eq(channels.spaceId, invite.spaceId)
  const general = (await db.select().from(channels).where(and(eq(channels.name, 'general'), inInvitedSpace)).limit(1))[0]
  const first = general ?? (await db.select().from(channels).where(and(eq(channels.type, 'text'), inInvitedSpace)).limit(1))[0]
  return { serverId: (await getServerId(cf(event).env.DB)), channelId: first?.id ?? null, projectId: invite.projectId }
})
