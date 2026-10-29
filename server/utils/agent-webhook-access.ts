import { and, eq, isNull } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { agents, roles, users } from '../../drizzle/schema'
import { Permission } from '../../shared/permissions'
import { requireMember } from './guards'
import { cf, fail } from './cf'
import { getDb } from './db'
import { assertRoleManageable } from './role-policy'

/** The same hierarchy as editing the Agent: its webhook decides where its Runs are sent. */
export async function requireManagedAgent(event: H3Event) {
  const serverId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const actor = await requireMember(event, serverId, Permission.manageAgents)
  const current = (await getDb(cf(event).env.DB).select({ role: roles }).from(agents)
    .innerJoin(users, eq(users.id, agents.userId)).innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(agents.userId, agentId), eq(users.status, 'active'), eq(users.kind, 'agent'), isNull(agents.archivedAt)))
    .limit(1))[0]
  if (!current) fail(404, 'not_found', 'Agent not found')
  assertRoleManageable(actor, current.role)
  return { serverId, agentId, actor }
}
