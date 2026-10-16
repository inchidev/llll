import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf } from '../../utils/cf'
import { requireDatabase, requireDatabaseItem } from '../../utils/database-data'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const item = await requireDatabaseItem(env, id)
  await requireDatabase(env, item.databaseId, true)
  await env.DB.prepare('DELETE FROM database_items WHERE id = ?').bind(id).run()
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'database_item.delete', targetType: 'database_item', targetId: id, meta: { databaseId: item.databaseId, title: item.title } })
  return { ok: true }
})
