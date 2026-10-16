import { z } from 'zod'
import { DatabaseViewLayouts } from '../../../shared/database'
import { nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf, fail } from '../../utils/cf'
import { databaseFieldsFor, requireDatabase } from '../../utils/database-data'
import { normalizeDatabaseViewConfig, parseDatabaseView, requireDatabaseView } from '../../utils/database-views'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  layout: z.enum(DatabaseViewLayouts).optional(),
  config: z.unknown().optional(),
  position: z.number().int().min(0).optional(),
  version: z.number().int().positive(),
}).refine(body => Object.keys(body).some(key => key !== 'version'), 'No changes')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const currentRow = await requireDatabaseView(env, id)
  await requireDatabase(env, currentRow.databaseId, true)
  if (currentRow.version !== body.version) fail(409, 'stale_database_view', 'This view changed elsewhere. Reload and try again.')
  if (body.name !== undefined && await env.DB.prepare(
    'SELECT id FROM database_views WHERE database_id = ? AND id <> ? AND lower(name) = lower(?) LIMIT 1',
  ).bind(currentRow.databaseId, id, body.name).first()) fail(409, 'duplicate_name', 'A view with this name already exists')

  const fields = await databaseFieldsFor(env, currentRow.databaseId)
  const current = parseDatabaseView(currentRow, fields)
  const layout = body.layout ?? current.layout
  const config = normalizeDatabaseViewConfig(body.config ?? current.config, fields, layout, true)
  const assignments = ['layout = ?', 'config_json = ?', 'updated_at = ?', 'version = version + 1']
  const values: Array<string | number> = [layout, JSON.stringify(config), nowIso()]
  if (body.name !== undefined) { assignments.push('name = ?'); values.push(body.name) }
  if (body.position !== undefined) { assignments.push('position = ?'); values.push(body.position) }
  const updated = await env.DB.prepare(
    `UPDATE database_views SET ${assignments.join(', ')} WHERE id = ? AND version = ?
     RETURNING id, database_id as databaseId, name, layout, config_json as configJson, position, version,
     created_by as createdBy, created_at as createdAt, updated_at as updatedAt`,
  ).bind(...values, id, body.version).first<Parameters<typeof parseDatabaseView>[0]>()
  if (!updated) fail(409, 'stale_database_view', 'This view changed elsewhere. Reload and try again.')
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'database_view.update', targetType: 'database_view', targetId: id, meta: { databaseId: current.databaseId, fields: Object.keys(body).filter(key => key !== 'version') } })
  return { view: parseDatabaseView(updated, fields) }
})
