import { z } from 'zod'
import { DatabaseViewLayouts, defaultDatabaseViewConfig } from '../../../../shared/database'
import { newId, nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { cf, fail } from '../../../utils/cf'
import { databaseFieldsFor, requireDatabase } from '../../../utils/database-data'
import { normalizeDatabaseViewConfig, parseDatabaseView } from '../../../utils/database-views'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  layout: z.enum(DatabaseViewLayouts),
  config: z.unknown().optional(),
})

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const databaseId = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await requireDatabase(env, databaseId, true)
  if (await env.DB.prepare('SELECT id FROM database_views WHERE database_id = ? AND lower(name) = lower(?) LIMIT 1').bind(databaseId, body.name).first()) {
    fail(409, 'duplicate_name', 'A view with this name already exists')
  }
  const fields = await databaseFieldsFor(env, databaseId)
  const config = normalizeDatabaseViewConfig(body.config ?? defaultDatabaseViewConfig(), fields, body.layout, true)
  const position = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) + 1024 as value FROM database_views WHERE database_id = ?')
    .bind(databaseId).first<{ value: number }>()
  const id = newId()
  const now = nowIso()
  await env.DB.prepare(
    `INSERT INTO database_views
     (id, database_id, name, layout, config_json, position, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).bind(id, databaseId, body.name, body.layout, JSON.stringify(config), position?.value ?? 1024, actor.user.id, now, now).run()
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'database_view.create', targetType: 'database_view', targetId: id, meta: { databaseId, name: body.name, layout: body.layout } })
  return { view: parseDatabaseView({ id, databaseId, name: body.name, layout: body.layout, configJson: JSON.stringify(config), position: position?.value ?? 1024, version: 1, createdBy: actor.user.id, createdAt: now, updatedAt: now }, fields) }
})
