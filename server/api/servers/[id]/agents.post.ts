import { agentProviderCatalog } from '../../../utils/agent-providers'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { agents, roles, users } from '../../../../drizzle/schema'
import { assertRoleAssignable } from '../../../utils/role-policy'
import { newId, nowIso } from '../../../../shared/ids'
import { hasPermission, Permission } from '../../../../shared/permissions'
import type { AgentDTO } from '../../../../shared/types'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'
import { signalMembersChanged } from '../../../../workers/member-events'
import { assertAgentNameAvailable } from '../../../utils/member-names'

const bodySchema = z.object({
  harness: z.literal('pi').optional(),
  roleId: z.string().min(8).optional(),
  displayName: z.string().trim().min(1).max(80),
  // Empty model resolves to this Server's default profile (openai-compatible: AI_MODEL).
  model: z.string().trim().max(200).default(''),
  instructions: z.string().trim().max(12_000).default(''),
})

export default defineEventHandler(async (event): Promise<{ agent: AgentDTO }> => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId, Permission.manageAgents)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const harness = 'pi'
  const model = body.model || (await agentProviderCatalog(env, { actorId: actor.user.id })).defaultModel || ''
  const db = getDb(env.DB)
  const memberRole = (await db.select().from(roles).where(eq(roles.key, 'member')).limit(1))[0]
  if (!memberRole) fail(409, 'server_incomplete', 'Member role not found')
  let selectedRole = memberRole
  if (body.roleId && body.roleId !== memberRole.id) {
    if (!actor.isOwner && !hasPermission(actor.perms, Permission.manageRoles)) fail(403, 'forbidden', 'Manage roles is required to choose an agent role')
    const role = (await db.select().from(roles).where(eq(roles.id, body.roleId)).limit(1))[0]
    if (!role) fail(404, 'not_found', 'Role not found')
    assertRoleAssignable(actor, role)
    selectedRole = role
  }

  await assertAgentNameAvailable(env, body.displayName)
  const id = newId()
  const now = nowIso()
  await db.batch([
    db.insert(users).values({
      id,
      kind: 'agent',
      handle: null,
      displayName: body.displayName,
      avatarR2Key: null,
      status: 'active',
      roleId: selectedRole.id,
      nickname: null,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(agents).values({
      userId: id,
      harness,
      model,
      instructions: body.instructions,
      status: 'active',
      createdBy: actor.user.id,
      lastActiveAt: null,
      createdAt: now,
      updatedAt: now,
    }),
  ])
  await writeAudit(env, {
    serverId,
    actorId: actor.user.id,
    action: 'agent.create',
    targetType: 'agent',
    targetId: id,
    meta: { displayName: body.displayName, model },
  })
  waitUntil(signalMembersChanged(env, serverId))
  return {
    agent: {
      id,
      roleId: selectedRole.id,
      harness,
      displayName: body.displayName,
      avatarR2Key: null,
      model,
      instructions: body.instructions,
      status: 'active',
      lastActiveAt: null,
      createdAt: now,
      updatedAt: now,
    },
  }
})
