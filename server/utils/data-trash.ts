import { authorize, authorizeResource, resourceAllowed, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { DataTrashTypes, type DataTrashEntry, type DataTrashType } from '../../shared/data-trash'
import { nowIso } from '../../shared/ids'
import { spaceSql } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { requireDatabase } from './database-data'
import { writeAudit } from './messages'

const sources = {
  database: { table: 'database_definitions', title: 'name', resource: 'databases', parent: false, version: false },
  record: { table: 'database_items', title: 'title', resource: 'databases', parent: true, version: true },
  field: { table: 'database_fields', title: 'name', resource: 'databases', parent: true, version: false },
  view: { table: 'database_views', title: 'name', resource: 'databases', parent: true, version: true },
  document: { table: 'documents', title: 'title', resource: 'documents', parent: false, version: true },
  canvas: { table: 'canvases', title: 'title', resource: 'canvases', parent: false, version: true },
} as const

export async function listDataTrash(env: L4Env, auth: AuthorizationContext): Promise<DataTrashEntry[]> {
  authorize(auth, ServerAction.manageData)
  const spaces = spaceSql(auth)
  const results = await env.DB.batch(DataTrashTypes.map(type => {
    const source = sources[type]
    const inSpaces = source.parent ? `database_id IN (SELECT id FROM database_definitions WHERE space_id IN (${spaces}))` : `space_id IN (${spaces})`
    return env.DB.prepare(`SELECT ? as type, id, ${source.title} as title, ${source.parent ? 'database_id' : 'id'} as resourceId, deleted_at as deletedAt FROM ${source.table} WHERE deleted_at IS NOT NULL AND ${inSpaces} ORDER BY deleted_at DESC`).bind(type)
  }))
  return results.flatMap(result => result.results as DataTrashEntry[])
    .filter(entry => resourceAllowed(auth, sources[entry.type].resource, entry.resourceId))
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/** Trash keeps the original rows, slots, links, grants and child resources intact. */
export async function changeDataTrash(env: L4Env, auth: AuthorizationContext, type: DataTrashType, id: string, action: 'trash' | 'restore' | 'purge') {
  authorize(auth, ServerAction.manageData)
  if (action === 'purge' && (auth.principal.kind !== 'human' || auth.credential.kind !== 'session')) fail(403, 'forbidden', 'Permanent deletion requires a human session')
  const source = sources[type]
  const row = await env.DB.prepare(`SELECT id, ${source.title} as title, ${source.parent ? 'database_id' : 'id'} as resourceId, deleted_at as deletedAt FROM ${source.table} WHERE id = ?`).bind(id).first<DataTrashEntry>()
  if (!row) fail(404, 'not_found', 'Data resource not found')
  authorizeResource(auth, source.resource, row.resourceId)
  if (source.parent) await requireDatabase(env, row.resourceId)
  if (action === 'trash' && row.deletedAt || action === 'restore' && !row.deletedAt) return { ok: true }
  if (action === 'purge' && !row.deletedAt) fail(409, 'not_in_trash', 'Move this resource to Trash before deleting it permanently')
  if (type === 'view' && action === 'trash') {
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM database_views WHERE database_id = ? AND deleted_at IS NULL').bind(row.resourceId).first<{ n: number }>()
    if ((count?.n ?? 0) <= 1) fail(409, 'last_database_view', 'Every database needs at least one view')
  }
  if (action === 'purge') {
    // Only purge frees a field slot; clear its data before a new field can claim it.
    const field = type === 'field' ? await env.DB.prepare('SELECT slot,type FROM database_fields WHERE id=?').bind(id).first<{ slot: string; type: string }>() : null
    const statements: D1PreparedStatement[] = []
    if (field && field.type !== 'relation') {
      if (!/^(text|number|boolean|date|select)_(?:[1-9]|1[0-6])$/u.test(field.slot)) fail(500, 'invalid_field_slot', 'Invalid field storage')
      statements.push(env.DB.prepare(`UPDATE database_items SET ${field.slot}=NULL, version=version+1 WHERE database_id=? AND EXISTS (SELECT 1 FROM database_fields WHERE id=? AND deleted_at IS NOT NULL)`).bind(row.resourceId, id))
    }
    statements.push(env.DB.prepare(`DELETE FROM ${source.table} WHERE id=? AND deleted_at IS NOT NULL`).bind(id))
    await env.DB.batch(statements)
  }
  else {
    const now = nowIso()
    const lastViewGuard = type === 'view' && action === 'trash' ? ' AND (SELECT COUNT(*) FROM database_views WHERE database_id=? AND deleted_at IS NULL)>1' : ''
    const saved = await env.DB.prepare(`UPDATE ${source.table} SET deleted_at=?, updated_at=?${source.version ? ', version=version+1' : ''} WHERE id=? AND deleted_at ${action === 'trash' ? 'IS NULL' : 'IS NOT NULL'}${lastViewGuard} RETURNING id`)
      .bind(action === 'trash' ? now : null, now, id, ...(lastViewGuard ? [row.resourceId] : [])).first()
    if (!saved) fail(409, 'data_conflict', 'Data changed elsewhere. Reload and try again.')
  }
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: `data.${action}`, targetType: type, targetId: id, meta: { title: row.title, resourceId: row.resourceId }, authorization: auth })
  return { ok: true }
}
