import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf } from '../../utils/cf'
import { databaseFieldsFor, requireDatabase, requireDatabaseField } from '../../utils/database-data'
import { loadDatabaseViews, normalizeDatabaseViewConfig } from '../../utils/database-views'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const field = await requireDatabaseField(env, id)
  await requireDatabase(env, field.databaseId, true)
  const remainingFields = (await databaseFieldsFor(env, field.databaseId)).filter(candidate => candidate.id !== id)
  const views = await loadDatabaseViews(env, field.databaseId)
  const viewRepairs = views.map((view) => {
    const config = normalizeDatabaseViewConfig(view.config, remainingFields, view.layout)
    const layout = (view.layout === 'board' && !config.groupFieldId) || (view.layout === 'calendar' && !config.dateFieldId)
      ? 'table'
      : view.layout
    return env.DB.prepare(
      'UPDATE database_views SET layout = ?, config_json = ?, version = version + 1, updated_at = ? WHERE id = ?',
    ).bind(layout, JSON.stringify(config), new Date().toISOString(), view.id)
  })
  await env.DB.batch([
    env.DB.prepare(`UPDATE database_items SET ${field.slot} = NULL, version = version + 1, updated_at = ? WHERE database_id = ?`).bind(new Date().toISOString(), field.databaseId),
    ...viewRepairs,
    env.DB.prepare('DELETE FROM database_fields WHERE id = ?').bind(id),
  ])
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'database_field.delete', targetType: 'database_field', targetId: id, meta: { databaseId: field.databaseId, name: field.name, type: field.type } })
  return { ok: true }
})
