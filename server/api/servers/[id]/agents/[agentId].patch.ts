import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { agents, users } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { Permission } from '../../../../../shared/permissions'
import type { AgentDTO } from '../../../../../shared/types'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'
import { parseBody } from '../../../../utils/validate'
import { signalMembersChanged } from '../../../../../workers/member-events'

const bodySchema = z.object({
  harness: z.literal('pi').optional(),
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
    .where(eq(agents.userId, agentId))
    .limit(1))[0]
  if (!current) fail(404, 'not_found', 'Agent not found')

  const harness = 'pi'
  const now = nowIso()
  const displayName = body.displayName ?? current.user.displayName
  const model = body.model ?? current.profile.model
  const instructions = body.instructions ?? current.profile.instructions
  const status = body.status ?? current.profile.status

  await db.batch([
    db.update(users).set({ displayName, updatedAt: now }).where(eq(users.id, agentId)),
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
      instructionsChanged: body.instructions !== undefined && body.instructions !== current.profile.instructions,
    },
  })
  if (body.displayName !== undefined || body.status !== undefined) {
    waitUntil(signalMembersChanged(env, serverId))
  }

  return {
    agent: {
      id: agentId,
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
