import { eq } from 'drizzle-orm'
import { agents, users } from '../../../../drizzle/schema'
import { Permission } from '../../../../shared/permissions'
import type { AgentDTO } from '../../../../shared/types'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'

export default defineEventHandler(async (event): Promise<{ agents: AgentDTO[] }> => {
  const workspaceId = getRouterParam(event, 'id')!
  await requireMember(event, workspaceId, Permission.manageWorkspace)
  const db = getDb(cf(event).env.DB)
  const rows = await db.select({ profile: agents, user: users }).from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .orderBy(users.displayName)
  return {
    agents: rows.map(({ profile, user }) => ({
      id: user.id,
      displayName: user.displayName,
      avatarR2Key: user.avatarR2Key,
      model: profile.model,
      instructions: profile.instructions,
      status: profile.status,
      lastActiveAt: profile.lastActiveAt,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })),
  }
})
