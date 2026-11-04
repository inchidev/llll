import { spaceOfResource } from '../../../utils/space-access'
import { insertDatabaseField } from '../../../utils/database-field-service'
import { getServerId } from '../../../../shared/server-id'
import { z } from 'zod'
import { DatabaseFieldTypes, hasFieldOptions, normalizeDatabaseOptions } from '../../../../shared/database'
import { newId, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { cf, fail } from '../../../utils/cf'
import { requireDatabase, requireDatabaseInSpace } from '../../../utils/database-data'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(DatabaseFieldTypes),
  options: z.array(z.string().max(80)).max(50).default([]),
  /** The database a relation field links to; it may be this one. */
  relation: z.object({ databaseId: z.string().min(1) }).optional(),
}).refine(body => body.type !== 'relation' || body.relation, 'A relation field needs a target database')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)), Permission.manageDatabases)
  const databaseId = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await requireDatabase(env, databaseId, true)
  const duplicate = await env.DB.prepare(
    'SELECT id FROM database_fields WHERE database_id = ? AND lower(name) = lower(?) LIMIT 1',
  ).bind(databaseId, body.name).first()
  if (duplicate) fail(409, 'duplicate_name', 'A field with this name already exists')
  const positionRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(position), 0) as position FROM database_fields WHERE database_id = ?',
  ).bind(databaseId).first<{ position: number }>()
  const id = newId()
  const now = nowIso()
  const options = hasFieldOptions(body.type) ? normalizeDatabaseOptions(body.options) : []
  const relation = body.type === 'relation' && body.relation ? { databaseId: await requireDatabaseInSpace(env, body.relation.databaseId, (await spaceOfResource(env, 'database', databaseId))!) } : null
  const position = (positionRow?.position ?? 0) + 1024
  const field = { id, databaseId, name: body.name, type: body.type, options, relation, position, createdAt: now, updatedAt: now }
  await insertDatabaseField(env, field, actor.user.id)
  await writeAudit(env, { serverId: (await getServerId(cf(event).env.DB)), actorId: actor.user.id, action: 'database_field.create', targetType: 'database_field', targetId: id, meta: { databaseId, name: body.name, type: body.type } })
  return { field }
})
