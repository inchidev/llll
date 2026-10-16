import { desc, eq } from 'drizzle-orm'
import { auditLog, users } from '../../../../drizzle/schema'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  await requireMember(event, workspaceId, Permission.manageWorkspace)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const rows = await db.select({
    log: auditLog,
    actorName: users.displayName,
  }).from(auditLog).innerJoin(users, eq(users.id, auditLog.actorId)).orderBy(desc(auditLog.createdAt)).limit(100)

  return {
    entries: rows.map((r) => ({
      id: r.log.id,
      workspaceId,
      actorId: r.log.actorId,
      actorName: r.actorName,
      action: r.log.action,
      targetType: r.log.targetType,
      targetId: r.log.targetId,
      meta: JSON.parse(r.log.metaJson || '{}') as Record<string, unknown>,
      createdAt: r.log.createdAt,
    })),
  }
})
