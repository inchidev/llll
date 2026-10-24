import { z } from 'zod'
import { newId, nowIso } from '../../shared/ids'
import { authorize, authorizeResource, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { databaseFieldsFor, databaseSqlValue, loadDatabaseItem, requireDatabase, requireDatabaseItem, databaseItemDto } from './database-data'
import { loadDatabasePage } from './database-views'
import { writeAudit } from './messages'

const valueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
export const createRecordSchema = z.object({ title: z.string().trim().min(1).max(500).default('Untitled'), values: z.record(z.string(), valueSchema).default({}) })
export const readRecordsSchema = z.object({ databaseId: z.string().min(1), page: z.number().int().positive().default(1), pageSize: z.number().int().min(1).max(100).default(50), search: z.string().max(200).default(''), viewId: z.string().min(1).optional() })
export const updateRecordSchema = z.object({ title: z.string().trim().min(1).max(500).optional(), values: z.record(z.string(), valueSchema).optional(), version: z.number().int().positive() }).refine(body => body.title !== undefined || body.values !== undefined, 'No changes')

export async function readRecords(env: L4Env, authorization: AuthorizationContext, databaseId: string, page = 1, options: { pageSize?: number, search?: string, viewId?: string } = {}) {
  authorize(authorization, ServerAction.readRecords)
  authorizeResource(authorization, 'databases', databaseId)
  const input = readRecordsSchema.parse({ databaseId, page, ...options })
  const data = await loadDatabasePage(env, databaseId, { ...input, viewId: input.viewId ?? null })
  return { ...data, view: input.viewId ? data.view : null, nextPage: input.page * input.pageSize < data.total ? input.page + 1 : null }
}

export async function createRecord(env: L4Env, authorization: AuthorizationContext, databaseId: string, input: z.input<typeof createRecordSchema>) {
  authorize(authorization, ServerAction.writeRecords)
  authorizeResource(authorization, 'databases', databaseId)
  const body = createRecordSchema.parse(input)
  await requireDatabase(env, databaseId, true)
  const fields = await databaseFieldsFor(env, databaseId)
  const fieldMap = new Map(fields.map(field => [field.id, field]))
  const columns = ['id', 'database_id', 'title', 'position', 'version', 'created_by', 'created_at', 'updated_at']
  const positionRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(position), 0) as position FROM database_items WHERE database_id = ?',
  ).bind(databaseId).first<{ position: number }>()
  const id = newId()
  const now = nowIso()
  const values: Array<string | number | null> = [id, databaseId, body.title, (positionRow?.position ?? 0) + 1024, 1, authorization.principal.id, now, now]
  for (const [fieldId, value] of Object.entries(body.values)) {
    const field = fieldMap.get(fieldId)
    if (!field) fail(400, 'bad_request', 'A supplied field does not belong to this database')
    columns.push(field.slot)
    values.push(databaseSqlValue(field, value))
  }
  const placeholders = columns.map(() => '?').join(', ')
  await env.DB.prepare(`INSERT INTO database_items (${columns.join(', ')}) VALUES (${placeholders})`).bind(...values).run()
  await writeAudit(env, { serverId: authorization.serverId, actorId: authorization.principal.id, action: 'database_item.create', targetType: 'database_item', targetId: id, meta: { databaseId, title: body.title }, authorization })
  return (await loadDatabaseItem(env, id))!
}
export async function updateRecord(env: L4Env, authorization: AuthorizationContext, id: string, input: z.input<typeof updateRecordSchema>) {
  authorize(authorization, ServerAction.writeRecords)
  const body = updateRecordSchema.parse(input)
  const item = await requireDatabaseItem(env, id)
  authorizeResource(authorization, 'databases', item.databaseId)
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
  await writeAudit(env, { serverId: authorization.serverId, actorId: authorization.principal.id, action: 'database_item.update', targetType: 'database_item', targetId: id, meta: { databaseId: item.databaseId, fields: [...Object.keys(body.values ?? {}), ...(body.title !== undefined ? ['title'] : [])] }, authorization })
  return databaseItemDto(updated, fields)
}
