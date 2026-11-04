import { sha256Hex } from '../../shared/server-settings'
import { z } from 'zod'
import { newId, nowIso } from '../../shared/ids'
import { authorize, authorizeResource, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { type StoredDatabaseField, databaseFieldsFor, databaseItemDto, linkStatements, loadDatabaseItem, prepareRecordValues, requireDatabase, requireDatabaseItem } from './database-data'
import { loadDatabasePage } from './database-views'
import { writeAudit } from './messages'

const valueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string().max(200)).max(100), z.null()])
export const createRecordSchema = z.object({ requestId: z.string().min(1).max(120).optional(), title: z.string().trim().min(1).max(500).default('Untitled'), values: z.record(z.string(), valueSchema).default({}) })
export const readRecordsSchema = z.object({ databaseId: z.string().min(1), page: z.number().int().positive().default(1), pageSize: z.number().int().min(1).max(100).default(50), search: z.string().max(200).default(''), viewId: z.string().min(1).optional() })
export const updateRecordSchema = z.object({ title: z.string().trim().min(1).max(500).optional(), values: z.record(z.string(), valueSchema).optional(), version: z.number().int().positive() }).refine(body => body.title !== undefined || body.values !== undefined, 'No changes')

/** Metadata is checked inside the write transaction, so a purged/reused slot cannot capture stale values. */
function recordWriteGuard(databaseId: string, fields: StoredDatabaseField[], supplied: Record<string, unknown>) {
  const expected = fields.filter(field => Object.hasOwn(supplied, field.id)).map(field => ({ id: field.id, slot: field.slot, type: field.type, options: JSON.stringify(field.options), relation: field.relation?.databaseId ?? null }))
  return {
    sql: `EXISTS (SELECT 1 FROM database_definitions WHERE id=? AND deleted_at IS NULL AND archived_at IS NULL)
      AND (SELECT COUNT(*) FROM database_fields f JOIN json_each(?) e ON f.id=json_extract(e.value,'$.id')
        WHERE f.database_id=? AND f.deleted_at IS NULL AND f.slot=json_extract(e.value,'$.slot') AND f.type=json_extract(e.value,'$.type')
        AND COALESCE(json_extract(f.config_json,'$.options'),'[]')=json_extract(e.value,'$.options')
        AND json_extract(f.config_json,'$.relation.databaseId') IS json_extract(e.value,'$.relation'))=?`,
    values: [databaseId, JSON.stringify(expected), databaseId, expected.length],
  }
}

export async function readRecords(env: L4Env, authorization: AuthorizationContext, databaseId: string, page = 1, options: { pageSize?: number, search?: string, viewId?: string } = {}) {
  authorize(authorization, ServerAction.readRecords)
  // Decided without the boundary: the database lookup makes another Space's answer as missing.
  authorizeResource(authorization, 'databases', databaseId)
  const input = readRecordsSchema.parse({ databaseId, page, ...options })
  const data = await loadDatabasePage(env, databaseId, { ...input, viewId: input.viewId ?? null, authorization })
  return { ...data, view: input.viewId ? data.view : null, nextPage: input.page * input.pageSize < data.total ? input.page + 1 : null }
}

export async function createRecord(env: L4Env, authorization: AuthorizationContext, databaseId: string, input: z.input<typeof createRecordSchema>) {
  authorize(authorization, ServerAction.writeRecords)
  authorizeResource(authorization, 'databases', databaseId)
  const body = createRecordSchema.parse(input)
  await requireDatabase(env, databaseId, true, authorization)
  const bodyHash = body.requestId ? await sha256Hex(JSON.stringify({ title: body.title, values: Object.fromEntries(Object.entries(body.values).sort(([a], [b]) => a.localeCompare(b))) })) : null
  const replay = async () => {
    if (!body.requestId) return null
    const receipt = await env.DB.prepare('SELECT record_id as recordId,body_hash as bodyHash FROM data_record_requests WHERE principal_id=? AND database_id=? AND request_id=?')
      .bind(authorization.principal.id, databaseId, body.requestId).first<{ recordId: string | null; bodyHash: string }>()
    if (!receipt) return null
    if (receipt.bodyHash !== bodyHash) fail(409, 'request_conflict', 'This request ID was already used for different values')
    const item = receipt.recordId ? await loadDatabaseItem(env, receipt.recordId) : null
    if (!item) fail(409, 'record_removed', 'The record created by this request was removed; restore it from Trash')
    return item
  }
  const previous = await replay()
  if (previous) return previous
  const fields = await databaseFieldsFor(env, databaseId)
  const fieldMap = new Map(fields.map(field => [field.id, field]))
  const columns = ['id', 'database_id', 'title', 'position', 'version', 'created_by', 'created_at', 'updated_at']
  const positionRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(position), 0) as position FROM database_items WHERE database_id = ?',
  ).bind(databaseId).first<{ position: number }>()
  const id = newId()
  const now = nowIso()
  const values: Array<string | number | null> = [id, databaseId, body.title, (positionRow?.position ?? 0) + 1024, 1, authorization.principal.id, now, now]
  const prepared = await prepareRecordValues(env, fieldMap, body.values, () => fail(400, 'bad_request', 'A supplied field does not belong to this database'), targetId => authorizeResource(authorization, 'databases', targetId))
  for (const column of prepared.columns) { columns.push(column.slot); values.push(column.value) }
  const placeholders = columns.map(() => '?').join(', ')
  const guard = recordWriteGuard(databaseId, fields, body.values)
  let saved: Parameters<typeof databaseItemDto>[0] | undefined
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO database_items (${columns.join(', ')}) SELECT ${placeholders} WHERE ${guard.sql} RETURNING *,database_id AS databaseId,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt`).bind(...values, ...guard.values),
      ...linkStatements(env, id, prepared.links, now),
      ...(body.requestId ? [env.DB.prepare('INSERT INTO data_record_requests(principal_id,database_id,request_id,record_id,body_hash) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM database_items WHERE id=?)')
        .bind(authorization.principal.id, databaseId, body.requestId, id, bodyHash, id)] : []),
    ])
    saved = results[0]?.results?.[0] as typeof saved
  }
  catch (error) { const committed = await replay(); if (committed) return committed; throw error }
  if (!saved) fail(409, 'schema_changed', 'The Database or its fields changed. Reload before retrying.')
  await writeAudit(env, { serverId: authorization.serverId, actorId: authorization.principal.id, action: 'database_item.create', targetType: 'database_item', targetId: id, meta: { databaseId, title: body.title }, authorization })
  return databaseItemDto(saved, fields, new Map(prepared.links.map(link => [link.field.id, link.targetIds])))
}
export async function updateRecord(env: L4Env, authorization: AuthorizationContext, id: string, input: z.input<typeof updateRecordSchema>) {
  authorize(authorization, ServerAction.writeRecords)
  const body = updateRecordSchema.parse(input)
  const item = await requireDatabaseItem(env, id, authorization)
  authorizeResource(authorization, 'databases', item.databaseId)
  await requireDatabase(env, item.databaseId, true)
  if (item.version !== body.version) fail(409, 'stale_record', 'This record changed elsewhere. Reload and try again.')
  const fields = await databaseFieldsFor(env, item.databaseId)
  const fieldMap = new Map(fields.map(field => [field.id, field]))
  const now = nowIso()
  const mutationId = newId()
  const assignments = ['updated_at = ?', 'version = version + 1', 'mutation_id = ?']
  const values: Array<string | number | null> = [now, mutationId]
  if (body.title !== undefined) { assignments.push('title = ?'); values.push(body.title) }
  const prepared = await prepareRecordValues(env, fieldMap, body.values ?? {}, () => fail(400, 'bad_request', 'A supplied field does not belong to this database'), targetId => authorizeResource(authorization, 'databases', targetId))
  for (const column of prepared.columns) { assignments.push(`${column.slot} = ?`); values.push(column.value) }
  const guard = recordWriteGuard(item.databaseId, fields, body.values ?? {})
  const results = await env.DB.batch([
    env.DB.prepare(
    `UPDATE database_items SET ${assignments.join(', ')} WHERE deleted_at IS NULL AND id = ? AND version = ? AND ${guard.sql}
     RETURNING *, database_id as databaseId, created_by as createdBy,
     created_at as createdAt, updated_at as updatedAt`,
    ).bind(...values, id, body.version, ...guard.values),
    ...linkStatements(env, id, prepared.links, now, mutationId),
    env.DB.prepare('SELECT field_id as fieldId, target_item_id as targetId FROM database_item_links WHERE item_id = ? ORDER BY position, created_at').bind(id),
  ])
  const updated = results[0]?.results?.[0] as Parameters<typeof databaseItemDto>[0] | undefined
  if (!updated) fail(409, 'stale_record', 'This record changed elsewhere. Reload and try again.')
  await writeAudit(env, { serverId: authorization.serverId, actorId: authorization.principal.id, action: 'database_item.update', targetType: 'database_item', targetId: id, meta: { databaseId: item.databaseId, fields: [...Object.keys(body.values ?? {}), ...(body.title !== undefined ? ['title'] : [])] }, authorization })
  // The response carries exactly what this update committed, whoever writes next.
  const links = new Map<string, string[]>()
  for (const row of results.at(-1)?.results ?? []) {
    const link = row as { fieldId: string; targetId: string }
    links.set(link.fieldId, [...links.get(link.fieldId) ?? [], link.targetId])
  }
  return databaseItemDto(updated, fields, links)
}
