import { getServerId } from '../../../shared/server-id'
import { Permission } from '../../../shared/permissions'
import { cf } from '../../utils/cf'
import { requireDatabase } from '../../utils/database-data'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)), Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const database = await requireDatabase(env, id)
  await env.DB.prepare('DELETE FROM database_definitions WHERE id = ?').bind(id).run()
  await writeAudit(env, { workspaceId: (await getServerId(cf(event).env.DB)), actorId: actor.user.id, action: 'database.delete', targetType: 'database', targetId: id, meta: { name: database.name } })
  return { ok: true }
})
