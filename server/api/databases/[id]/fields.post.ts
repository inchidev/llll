import { z } from 'zod'
import { DatabaseFieldTypes, normalizeDatabaseOptions } from '../../../../shared/database'
import { newId, nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { cf, fail } from '../../../utils/cf'
import { allocateDatabaseSlot, requireDatabase } from '../../../utils/database-data'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(DatabaseFieldTypes),
  options: z.array(z.string().max(80)).max(50).default([]),
})

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const databaseId = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await requireDatabase(env, databaseId, true)
  const duplicate = await env.DB.prepare(
    'SELECT id FROM database_fields WHERE database_id = ? AND lower(name) = lower(?) LIMIT 1',
  ).bind(databaseId, body.name).first()
  if (duplicate) fail(409, 'duplicate_name', 'A field with this name already exists')
  const slot = await allocateDatabaseSlot(env, databaseId, body.type)
  const positionRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(position), 0) as position FROM database_fields WHERE database_id = ?',
  ).bind(databaseId).first<{ position: number }>()
  const id = newId()
  const now = nowIso()
  const options = body.type === 'select' ? normalizeDatabaseOptions(body.options) : []
  const position = (positionRow?.position ?? 0) + 1024
  await env.DB.prepare(
    `INSERT INTO database_fields
     (id, database_id, name, type, slot, config_json, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, databaseId, body.name, body.type, slot, JSON.stringify({ options }), position, actor.user.id, now, now).run()
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'database_field.create', targetType: 'database_field', targetId: id, meta: { databaseId, name: body.name, type: body.type } })
  return { field: { id, databaseId, name: body.name, type: body.type, options, position, createdAt: now, updatedAt: now } }
})
