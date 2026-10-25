import { z } from 'zod'
import { parseBody } from '../../../utils/validate'
import { agentDirectoryPage } from '../../../utils/agent-directory-page'
import { and, eq } from 'drizzle-orm'
import { agents, users } from '../../../../drizzle/schema'
import { Permission } from '../../../../shared/permissions'
import type { AgentDTO } from '../../../../shared/types'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'

export default defineEventHandler(async (event): Promise<{ agents: AgentDTO[]; total?: number }> => {
  const serverId = getRouterParam(event, 'id')!
  await requireMember(event, serverId, Permission.manageAgents)
  const query = getQuery(event)
  if (query.page !== undefined) {
    const { search, page } = parseBody(z.object({ search: z.string().max(160).default(''), page: z.coerce.number().int().min(1).max(1000000) }), query)
    return agentDirectoryPage(cf(event).env, search, page)
  }
  const db = getDb(cf(event).env.DB)
  const rows = await db.select({ profile: agents, user: users }).from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(and(eq(users.status, 'active'), eq(users.kind, 'agent')))
    .orderBy(users.displayName)
  return {
    agents: rows.map(({ profile, user }) => ({
      id: user.id,
      roleId: user.roleId,
      displayName: user.displayName,
      avatarR2Key: user.avatarR2Key,
      model: profile.model,
      harness: profile.harness,
      instructions: profile.instructions,
      status: profile.status,
      lastActiveAt: profile.lastActiveAt,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })),
  }
})
