import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf, fail } from '../../utils/cf'
import { requireDatabase } from '../../utils/database-data'
import { requireDatabaseView } from '../../utils/database-views'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const view = await requireDatabaseView(env, id)
  await requireDatabase(env, view.databaseId, true)
  const count = await env.DB.prepare('SELECT COUNT(*) as value FROM database_views WHERE database_id = ?').bind(view.databaseId).first<{ value: number }>()
  if ((count?.value ?? 0) <= 1) fail(409, 'last_database_view', 'Every database needs at least one view')
  await env.DB.prepare('DELETE FROM database_views WHERE id = ?').bind(id).run()
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'database_view.delete', targetType: 'database_view', targetId: id, meta: { databaseId: view.databaseId, name: view.name } })
  return { ok: true }
})
