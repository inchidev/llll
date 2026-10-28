import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { agents, roles, users } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { hasPermission, Permission } from '../../../../../shared/permissions'
import type { AgentDTO } from '../../../../../shared/types'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'
import { parseBody } from '../../../../utils/validate'
import { assertRoleAssignable, assertRoleManageable } from '../../../../utils/role-policy'
import { revalidateLiveRooms } from '../../../../utils/live'
import { signalMembersChanged } from '../../../../../workers/member-events'
import { assertAgentModelSupportsTools } from '../../../../utils/agent-model-options'
import { assertAgentNameAvailable } from '../../../../utils/member-names'

const bodySchema = z.object({
  harness: z.literal('pi').optional(),
  roleId: z.string().min(8).optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().max(200).optional(),
  instructions: z.string().trim().max(12_000).optional(),
  status: z.enum(['active', 'paused']).optional(),
}).refine(body => Object.values(body).some(value => value !== undefined), 'No changes')

export default defineEventHandler(async (event): Promise<{ agent: AgentDTO }> => {
  const serverId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const actor = await requireMember(event, serverId, Permission.manageAgents)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const current = (await db.select({ profile: agents, user: users }).from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(and(eq(agents.userId, agentId), eq(users.status, 'active'), eq(users.kind, 'agent')))
    .limit(1))[0]
  if (!current) fail(404, 'not_found', 'Agent not found')

  // Any edit, not only a role change: instructions run with the authority of whoever
  // next invokes the Agent, so editing a higher-Role Agent would plant them there.
  const currentRole = (await db.select().from(roles).where(eq(roles.id, current.user.roleId ?? '')).limit(1))[0]
  if (!currentRole) fail(404, 'not_found', 'Role not found')
  assertRoleManageable(actor, currentRole)
  if (body.roleId !== undefined) {
    if (!actor.isOwner && !hasPermission(actor.perms, Permission.manageRoles)) fail(403, 'forbidden', 'Manage roles is required to change an agent role')
    const nextRole = (await db.select().from(roles).where(eq(roles.id, body.roleId)).limit(1))[0]
    if (!nextRole) fail(404, 'not_found', 'Role not found')
    assertRoleAssignable(actor, nextRole)
  }
  if (body.displayName !== undefined && body.displayName !== current.user.displayName) await assertAgentNameAvailable(env, body.displayName, agentId)
  if (body.model !== undefined && body.model !== current.profile.model) await assertAgentModelSupportsTools(env, body.model)
  const roleId = body.roleId ?? current.user.roleId
  const roleChanged = roleId !== current.user.roleId
  const harness = 'pi'
  const now = nowIso()
  const displayName = body.displayName ?? current.user.displayName
  const model = body.model ?? current.profile.model
  const instructions = body.instructions ?? current.profile.instructions
  const status = body.status ?? current.profile.status

  await db.batch([
    db.update(users).set({ displayName, ...(body.roleId !== undefined ? { roleId } : {}), updatedAt: now }).where(eq(users.id, agentId)),
    db.update(agents).set({ harness, model, instructions, status, updatedAt: now }).where(eq(agents.userId, agentId)),
  ])
  await writeAudit(env, {
    serverId,
    actorId: actor.user.id,
    action: 'agent.update',
    targetType: 'agent',
    targetId: agentId,
    meta: {
      displayName,
      model,
      status,
      roleChanged,
      ...(roleChanged ? { previousRoleId: current.user.roleId, roleId } : {}),
      instructionsChanged: body.instructions !== undefined && body.instructions !== current.profile.instructions,
    },
  })
  if (body.displayName !== undefined || body.status !== undefined || roleChanged) {
    waitUntil(signalMembersChanged(env, serverId))
  }

  if (roleChanged) waitUntil(revalidateLiveRooms(env))

  return {
    agent: {
      id: agentId,
      roleId,
      harness,
      displayName,
      avatarR2Key: current.user.avatarR2Key,
      model,
      instructions,
      status,
      lastActiveAt: current.profile.lastActiveAt,
      createdAt: current.profile.createdAt,
      updatedAt: now,
    },
  }
})
