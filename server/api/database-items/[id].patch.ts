import { z } from 'zod'
import { nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf, fail } from '../../utils/cf'
import { databaseFieldsFor, databaseItemDto, databaseSqlValue, requireDatabase, requireDatabaseItem } from '../../utils/database-data'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { parseBody } from '../../utils/validate'

const valueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
const bodySchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  values: z.record(z.string(), valueSchema).optional(),
  version: z.number().int().positive(),
}).refine(body => body.title !== undefined || body.values !== undefined, 'No changes')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const item = await requireDatabaseItem(env, id)
  await requireDatabase(env, item.databaseId, true)
  if (item.version !== body.version) fail(409, 'stale_record', 'This record changed elsewhere. Reload and try again.')
  const fields = await databaseFieldsFor(env, item.databaseId)
  const fieldMap = new Map(fields.map(field => [field.id, field]))
  const assignments = ['updated_at = ?', 'version = version + 1']
  const values: Array<string | number | null> = [nowIso()]
  if (body.title !== undefined) { assignments.push('title = ?'); values.push(body.title) }
  for (const [fieldId, value] of Object.entries(body.values ?? {})) {
    const field = fieldMap.get(fieldId)
    if (!field) fail(400, 'bad_request', 'A supplied field does not belong to this database')
    assignments.push(`${field.slot} = ?`)
    values.push(databaseSqlValue(field, value))
  }
  const updated = await env.DB.prepare(
    `UPDATE database_items SET ${assignments.join(', ')} WHERE id = ? AND version = ?
     RETURNING *, database_id as databaseId, created_by as createdBy,
     created_at as createdAt, updated_at as updatedAt`,
  ).bind(...values, id, body.version).first<Parameters<typeof databaseItemDto>[0]>()
  if (!updated) fail(409, 'stale_record', 'This record changed elsewhere. Reload and try again.')
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'database_item.update', targetType: 'database_item', targetId: id, meta: { databaseId: item.databaseId, fields: [...Object.keys(body.values ?? {}), ...(body.title !== undefined ? ['title'] : [])] } })
  return { item: databaseItemDto(updated, fields) }
})
