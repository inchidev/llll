import { and, eq } from 'drizzle-orm'
import { agents, users } from '../../../../drizzle/schema'
import { Permission } from '../../../../shared/permissions'
import type { TaskAgentDTO } from '../../../../shared/types'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<{ agents: TaskAgentDTO[] }> => {
  const serverId = getRouterParam(event, 'id')!
  await requireMember(event, serverId, Permission.readTasks)
  const db = getDb(cf(event).env.DB)
  const rows = await db.select({ profile: agents, user: users }).from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(and(eq(users.status, 'active'), eq(users.kind, 'agent')))
    .orderBy(users.displayName)

  return {
    agents: rows.map(({ profile, user }) => ({
      id: user.id,
      displayName: user.displayName,
      avatarR2Key: user.avatarR2Key,
      status: profile.status,
    })),
  }
})
