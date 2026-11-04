import { z } from 'zod'
import { authorize, authorizeResource, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { DataReferenceTypes, type DataReferenceType, type DataSearchHit, type DataReferences } from '../../shared/data-search'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { requireDatabase } from './database-data'
import { requireItem } from './item-access'
import { getTask } from './task-service'
import { requireTaskPermission } from './task-policy'
import { fail } from './cf'
import { writeAudit } from './messages'
import { spaceOfResource } from './space-access'

export const dataReferenceSchema = z.object({ type: z.enum(DataReferenceTypes), id: z.string().min(1).max(200) })
export const dataReferenceWriteSchema = z.object({ source: dataReferenceSchema, target: dataReferenceSchema, remove: z.boolean().default(false) })

const spaceOfReference = (env: L4Env, type: DataReferenceType, id: string) =>
  spaceOfResource(env, type, id)

/** Resolve every title under today's permissions; stored references never grant access. */
export async function resolveDataReference(env: L4Env, auth: AuthorizationContext, type: DataReferenceType, id: string, write = false): Promise<DataSearchHit> {
  if (type === 'task') {
    const task = await getTask(env, auth, id)
    if (!task) fail(404, 'not_found', 'Task not found')
    if (write) {
      requireTaskPermission(auth, task, Permission.writeTasks)
      if (task.archivedAt) fail(409, 'task_archived', 'Restore this Task before adding links')
    }
    return { type, id: task.id, title: task.title, resourceId: task.boardId }
  }
  if (type === 'database') {
    authorize(auth, write ? ServerAction.manageData : ServerAction.readRecords)
    authorizeResource(auth, 'databases', id)
    const database = await requireDatabase(env, id, write, auth)
    return { type, id, title: database.name, resourceId: id }
  }
  const item = await requireItem(env, auth, id, write)
  return { type: 'item', id, title: item.title, resourceId: item.databaseId ?? id }
}

export async function visibleDataReference(env: L4Env, auth: AuthorizationContext, type: DataReferenceType, id: string) {
  try { return await resolveDataReference(env, auth, type, id) }
  catch (error) {
    const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : null
    if (status === 403 || status === 404) return null
    throw error
  }
}

export async function listDataReferences(env: L4Env, auth: AuthorizationContext, type: DataReferenceType, id: string): Promise<DataReferences> {
  const source = await resolveDataReference(env, auth, type, id)
  const space = await spaceOfReference(env, type, source.id)
  const result: DataReferences = { outgoing: [], incoming: [] }
  for (const direction of ['outgoing', 'incoming'] as const) {
    const from = direction === 'outgoing' ? 'source' : 'target'
    const to = direction === 'outgoing' ? 'target' : 'source'
    // Page through metadata so inaccessible backlinks cannot hide accessible ones.
    for (let offset = 0; result[direction].length < 100; offset += 100) {
      const rows = (await env.DB.prepare(`SELECT ${to}_type AS type, ${to}_id AS id FROM data_references WHERE ${from}_type=? AND ${from}_id=? ORDER BY created_at,${to}_type,${to}_id LIMIT 100 OFFSET ?`).bind(source.type, source.id, offset).all<{ type: DataReferenceType; id: string }>()).results
      for (const row of rows) {
        const hit = await visibleDataReference(env, auth, row.type, row.id)
        // A link never crosses a Space, even for someone in both.
        if (hit && result[direction].length < 100 && await spaceOfReference(env, row.type, row.id) === space) result[direction].push(hit)
      }
      if (rows.length < 100) break
    }
  }
  return result
}

export async function changeDataReference(env: L4Env, auth: AuthorizationContext, input: z.input<typeof dataReferenceWriteSchema>) {
  const body = dataReferenceWriteSchema.parse(input)
  const source = await resolveDataReference(env, auth, body.source.type, body.source.id, true)
  const target = await resolveDataReference(env, auth, body.target.type, body.target.id)
  if (source.type === target.type && source.id === target.id) fail(400, 'self_reference', 'Choose a different resource')
  if (body.remove) await env.DB.prepare('DELETE FROM data_references WHERE source_type=? AND source_id=? AND target_type=? AND target_id=?').bind(source.type, source.id, target.type, target.id).run()
  else {
    if (await spaceOfReference(env, source.type, source.id) !== await spaceOfReference(env, target.type, target.id)) fail(404, 'not_found', 'Data resource not found')
    await env.DB.prepare(`INSERT OR IGNORE INTO data_references(source_type,source_id,target_type,target_id,created_by)
      SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM data_references WHERE source_type=? AND source_id=?)<100`).bind(source.type, source.id, target.type, target.id, auth.principal.id, source.type, source.id).run()
    const exists = await env.DB.prepare('SELECT 1 FROM data_references WHERE source_type=? AND source_id=? AND target_type=? AND target_id=?').bind(source.type, source.id, target.type, target.id).first()
    if (!exists) fail(409, 'reference_limit', 'A resource can link to at most 100 other resources')
  }
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: body.remove ? 'data.reference.remove' : 'data.reference.add', targetType: source.type, targetId: source.id, meta: { targetType: target.type, targetId: target.id }, authorization: auth })
  return { ok: true }
}
