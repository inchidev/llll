import { z } from 'zod'
import { newId, nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { cf, fail } from '../../../utils/cf'
import { databaseFieldsFor, databaseSqlValue, loadDatabaseItem, requireDatabase } from '../../../utils/database-data'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const valueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
const bodySchema = z.object({
  title: z.string().trim().min(1).max(500).default('Untitled'),
  values: z.record(z.string(), valueSchema).default({}),
})

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const databaseId = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await requireDatabase(env, databaseId, true)
  const fields = await databaseFieldsFor(env, databaseId)
  const fieldMap = new Map(fields.map(field => [field.id, field]))
  const columns = ['id', 'database_id', 'title', 'position', 'version', 'created_by', 'created_at', 'updated_at']
  const positionRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(position), 0) as position FROM database_items WHERE database_id = ?',
  ).bind(databaseId).first<{ position: number }>()
  const id = newId()
  const now = nowIso()
  const values: Array<string | number | null> = [id, databaseId, body.title, (positionRow?.position ?? 0) + 1024, 1, actor.user.id, now, now]
  for (const [fieldId, value] of Object.entries(body.values)) {
    const field = fieldMap.get(fieldId)
    if (!field) fail(400, 'bad_request', 'A supplied field does not belong to this database')
    columns.push(field.slot)
    values.push(databaseSqlValue(field, value))
  }
  const placeholders = columns.map(() => '?').join(', ')
  await env.DB.prepare(`INSERT INTO database_items (${columns.join(', ')}) VALUES (${placeholders})`).bind(...values).run()
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'database_item.create', targetType: 'database_item', targetId: id, meta: { databaseId, title: body.title } })
  return { item: await loadDatabaseItem(env, id) }
})
