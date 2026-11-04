import { and, eq, sql } from 'drizzle-orm'
import { spaceSql } from '../../../../shared/spaces'
import { roles, users } from '../../../../drizzle/schema'
import { hasPermission, Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { toRoleDto } from '../../../utils/role-policy'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId)
  if (!hasPermission(actor.perms, Permission.manageRoles)
    && !hasPermission(actor.perms, Permission.manageChannels)
    && !hasPermission(actor.perms, Permission.manageAgents)
    && !hasPermission(actor.perms, Permission.manageGadgets)) {
    fail(403, 'forbidden', 'Missing permission')
  }
  const { env } = cf(event)
  const db = getDb(env.DB)
  const [roleRows, memberRows, policyRows] = await Promise.all([
    db.select().from(roles).orderBy(roles.position),
    db.select({ roleId: users.roleId }).from(users).where(and(eq(users.status, 'active'), sql`${users.id} IN (SELECT user_id FROM space_members WHERE space_id IN (${sql.raw(spaceSql(actor.authorization))}))`)),
    env.DB.prepare('SELECT role_id AS roleId, count(*) AS count FROM role_policies GROUP BY role_id').all<{ roleId: string; count: number }>(),
  ])
  const counts = new Map<string, number>()
  for (const member of memberRows) {
    if (member.roleId) counts.set(member.roleId, (counts.get(member.roleId) ?? 0) + 1)
  }
  const policyCounts = new Map(policyRows.results.map(row => [row.roleId, row.count]))
  return { roles: roleRows.map(role => ({ ...toRoleDto(role, serverId, counts.get(role.id) ?? 0), policyCount: policyCounts.get(role.id) ?? 0 })) }
})
