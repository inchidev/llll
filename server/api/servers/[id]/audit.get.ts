import { and, desc, eq, sql } from 'drizzle-orm'
import { spaceAllowed, spaceSql } from '../../../../shared/spaces'
import { auditLog, users } from '../../../../drizzle/schema'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId, Permission.manageServer)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const rows = await db.select({
    log: auditLog,
    actorName: users.displayName,
  }).from(auditLog).innerJoin(users, eq(users.id, auditLog.actorId))
    // The Owner sees that something happened everywhere; only a Space they are in tells them what.
    .where(and(sql`${auditLog.action} NOT GLOB 'tool.connection.*'`, member.isOwner ? undefined : sql`(${auditLog.spaceId} IN (${sql.raw(spaceSql(member.authorization))})
      OR (${auditLog.spaceId} IS NULL AND ${auditLog.targetType} IN ('server', 'user', 'role', 'policy', 'ai_function', 'agent_provider', 'onboarding_revision', 'git_connection', 'mcp_connection')))`)).orderBy(desc(auditLog.createdAt)).limit(100)

  return {
    entries: rows.map((r) => ({
      id: r.log.id,
      serverId,
      actorId: r.log.actorId,
      actorName: r.actorName,
      action: r.log.action,
      targetType: r.log.targetType,
      targetId: r.log.targetId,
      meta: (r.log.spaceId && !spaceAllowed(member.authorization, r.log.spaceId) ? {} : JSON.parse(r.log.metaJson || '{}')) as Record<string, unknown>,
      createdAt: r.log.createdAt,
    })),
  }
})
