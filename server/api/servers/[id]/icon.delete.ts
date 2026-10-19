import { eq } from 'drizzle-orm'
import { server } from '../../../../drizzle/schema'
import { nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId, Permission.manageServer)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const current = (await db.select({ iconR2Key: server.iconR2Key }).from(server)
    .where(eq(server.id, serverId)).limit(1))[0]
  if (!current) fail(404, 'not_found', 'Server not found')
  await db.update(server).set({ iconR2Key: null, updatedAt: nowIso() }).where(eq(server.id, serverId))
  if (current.iconR2Key) await requireFiles(env).delete(current.iconR2Key)
  await writeAudit(env, {
    serverId,
    actorId: member.user.id,
    action: 'server.icon.delete',
    targetType: 'server',
    targetId: serverId,
  })
  return { ok: true }
})
