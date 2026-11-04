import {
  authorize,
  authorizeResource,
  resourceAllowed,
  ServerAction,
  type AuthorizationContext,
} from '../../shared/authorization'
import type { DataTrashEntry, DataTrashType } from '../../shared/data-trash'
import { requireItem } from './item-access'
import { newId, nowIso } from '../../shared/ids'
import { spaceSql } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { requireDatabase } from './database-data'
import { writeAudit } from './messages'

const sources = {
  database: { table: 'database_definitions', title: 'name', resource: 'databases', parent: false, version: false },
  field: { table: 'database_fields', title: 'name', resource: 'databases', parent: true, version: false },
  view: { table: 'database_views', title: 'name', resource: 'databases', parent: true, version: true },
} as const

export async function listDataTrash(env: L4Env, auth: AuthorizationContext): Promise<DataTrashEntry[]> {
  authorize(auth, ServerAction.manageData)
  const spaces = spaceSql(auth)
  const results = await env.DB.batch(
    (['database', 'field', 'view'] as const).map((type) => {
      const source = sources[type]
      const inSpaces = source.parent
        ? `database_id IN (SELECT id FROM database_definitions WHERE space_id IN (${spaces}))`
        : `space_id IN (${spaces})`
      return env.DB.prepare(
        `SELECT ? as type, id, ${source.title} as title, ${source.parent ? 'database_id' : 'id'} as resourceId, deleted_at as deletedAt FROM ${source.table} WHERE deleted_at IS NOT NULL AND ${inSpaces} ORDER BY deleted_at DESC`,
      ).bind(type)
    }),
  )
  const items = (
    await env.DB.prepare(
      `SELECT 'item' AS type,id,title,COALESCE(database_id,id) AS resourceId,deleted_at AS deletedAt FROM data_items WHERE deleted_at IS NOT NULL AND space_id IN (${spaces})`,
    ).all<DataTrashEntry>()
  ).results
  const visible: DataTrashEntry[] = []
  for (const item of items) {
    try {
      await requireItem(env, auth, item.id, false, true)
      visible.push(item)
    } catch (error) {
      if (![403, 404].includes(Number((error as { statusCode?: number }).statusCode))) throw error
    }
  }
  return [
    ...visible,
    ...results
      .flatMap((result) => result.results as DataTrashEntry[])
      .filter((entry) => resourceAllowed(auth, sources[entry.type as keyof typeof sources].resource, entry.resourceId)),
  ].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/** Trash keeps the original rows, slots, links, grants and child resources intact. */
export async function changeDataTrash(
  env: L4Env,
  auth: AuthorizationContext,
  type: DataTrashType,
  id: string,
  action: 'trash' | 'restore' | 'purge',
) {
  authorize(auth, ServerAction.manageData)
  if (action === 'purge' && (auth.principal.kind !== 'human' || auth.credential.kind !== 'session'))
    fail(403, 'forbidden', 'Permanent deletion requires a human session')
  if (type === 'item') return changeItemTrash(env, auth, id, action)
  const source = sources[type]
  const row = await env.DB.prepare(
    `SELECT id, ${source.title} as title, ${source.parent ? 'database_id' : 'id'} as resourceId, deleted_at as deletedAt FROM ${source.table} WHERE id = ?`,
  )
    .bind(id)
    .first<DataTrashEntry>()
  if (!row) fail(404, 'not_found', 'Data resource not found')
  authorizeResource(auth, source.resource, row.resourceId)
  if (source.parent) await requireDatabase(env, row.resourceId, false, auth)
  if ((action === 'trash' && row.deletedAt) || (action === 'restore' && !row.deletedAt)) return { ok: true }
  if (action === 'purge' && !row.deletedAt)
    fail(409, 'not_in_trash', 'Move this resource to Trash before deleting it permanently')
  if (type === 'view' && action === 'trash') {
    const count = await env.DB.prepare(
      'SELECT COUNT(*) as n FROM database_views WHERE database_id = ? AND deleted_at IS NULL',
    )
      .bind(row.resourceId)
      .first<{ n: number }>()
    if ((count?.n ?? 0) <= 1) fail(409, 'last_database_view', 'Every database needs at least one view')
  }
  if (action === 'purge') {
    if (type === 'database') {
      await purgeItems(env, auth, 'database', id)
      await writeAudit(env, {
        serverId: auth.serverId,
        actorId: auth.principal.id,
        action: 'data.purge',
        targetType: type,
        targetId: id,
        meta: { title: row.title },
        authorization: auth,
      })
      return { ok: true }
    }
    // Only purge frees a field slot; clear its data before a new field can claim it.
    const field =
      type === 'field'
        ? await env.DB.prepare('SELECT slot,type FROM database_fields WHERE id=?')
            .bind(id)
            .first<{ slot: string; type: string }>()
        : null
    const statements: D1PreparedStatement[] = []
    if (field && field.type !== 'relation') {
      if (!/^(text|number|boolean|date|select)_(?:[1-9]|1[0-6])$/u.test(field.slot))
        fail(500, 'invalid_field_slot', 'Invalid field storage')
      statements.push(
        env.DB.prepare(
          `UPDATE data_items SET ${field.slot}=NULL, version=version+1 WHERE database_id=? AND EXISTS (SELECT 1 FROM database_fields WHERE id=? AND deleted_at IS NOT NULL)`,
        ).bind(row.resourceId, id),
      )
    }
    statements.push(env.DB.prepare(`DELETE FROM ${source.table} WHERE id=? AND deleted_at IS NOT NULL`).bind(id))
    await env.DB.batch(statements)
  } else {
    const now = nowIso()
    const lastViewGuard =
      type === 'view' && action === 'trash'
        ? ' AND (SELECT COUNT(*) FROM database_views WHERE database_id=? AND deleted_at IS NULL)>1'
        : ''
    const saved = await env.DB.prepare(
      `UPDATE ${source.table} SET deleted_at=?, updated_at=?${source.version ? ', version=version+1' : ''} WHERE id=? AND deleted_at ${action === 'trash' ? 'IS NULL' : 'IS NOT NULL'}${lastViewGuard} RETURNING id`,
    )
      .bind(action === 'trash' ? now : null, now, id, ...(lastViewGuard ? [row.resourceId] : []))
      .first()
    if (!saved) fail(409, 'data_conflict', 'Data changed elsewhere. Reload and try again.')
  }
  await writeAudit(env, {
    serverId: auth.serverId,
    actorId: auth.principal.id,
    action: `data.${action}`,
    targetType: type,
    targetId: id,
    meta: { title: row.title, resourceId: row.resourceId },
    authorization: auth,
  })
  return { ok: true }
}

/** The first statement claims an unchanged subtree; every deletion checks that transaction-local claim. */
async function purgeItems(env: L4Env, auth: AuthorizationContext, kind: 'item' | 'database', id: string) {
  const selection = kind === 'item' ? 'id=?' : 'database_id=?'
  const tree = `WITH RECURSIVE tree(id,depth) AS (
    SELECT id,0 FROM data_items WHERE ${selection}
    UNION ALL SELECT c.id,t.depth+1 FROM data_items c JOIN tree t ON c.parent_id=t.id
  )`
  const rows = (
    await env.DB.prepare(
      `${tree} SELECT i.id,i.version,i.parent_id AS parentId,i.database_id AS databaseId,MAX(t.depth) AS depth FROM tree t JOIN data_items i ON i.id=t.id GROUP BY i.id ORDER BY depth DESC`,
    )
      .bind(id)
      .all<{ id: string; version: number; parentId: string | null; databaseId: string | null }>()
  ).results
  for (const row of rows) await requireItem(env, auth, row.id, false, true)
  const table = kind === 'item' ? 'data_items' : 'database_definitions'
  const markerColumn = kind === 'item' ? 'mutation_id' : 'updated_at'
  const root = await env.DB.prepare(`SELECT deleted_at AS deletedAt,updated_at AS updatedAt FROM ${table} WHERE id=?`)
    .bind(id)
    .first<{ deletedAt: string | null; updatedAt: string }>()
  if (!root?.deletedAt) fail(409, 'not_in_trash', 'Move this resource to Trash first')
  const marker = newId()
  // updated_at is only a transaction-local claim for a Database that is deleted in the same batch.
  const claim = env.DB.prepare(
    `UPDATE ${table} SET ${markerColumn}=? WHERE id=? AND deleted_at=? AND updated_at=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN data_items i ON i.id=json_extract(e.value,'$.id')
      WHERE i.id IS NULL OR i.version<>json_extract(e.value,'$.version') OR i.parent_id IS NOT json_extract(e.value,'$.parentId') OR i.database_id IS NOT json_extract(e.value,'$.databaseId'))
    AND (${tree} SELECT COUNT(DISTINCT id) FROM tree)=? RETURNING id`,
  ).bind(marker, id, root.deletedAt, root.updatedAt, JSON.stringify(rows), id, rows.length)
  const guard = `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND ${markerColumn}=?)`
  const result = await env.DB.batch([
    claim,
    ...rows.map((row) => env.DB.prepare(`DELETE FROM data_items WHERE id=? AND ${guard}`).bind(row.id, id, marker)),
    ...(kind === 'database'
      ? [env.DB.prepare(`DELETE FROM database_definitions WHERE id=? AND ${markerColumn}=?`).bind(id, marker)]
      : []),
  ])
  if (!result[0]?.results.length) fail(409, 'data_conflict', 'Data changed elsewhere. Reload before deleting it.')
}
async function changeItemTrash(
  env: L4Env,
  auth: AuthorizationContext,
  id: string,
  action: 'trash' | 'restore' | 'purge',
) {
  const item = await requireItem(env, auth, id, false, true)
  const row = await env.DB.prepare('SELECT deleted_at AS deletedAt FROM data_items WHERE id=?')
    .bind(id)
    .first<{ deletedAt: string | null }>()
  if (action === 'purge') {
    if (!row?.deletedAt) fail(409, 'not_in_trash', 'Move this Item to Trash first')
    await purgeItems(env, auth, 'item', id)
  } else {
    if (action === 'restore') {
      if (item.parentId) await requireItem(env, auth, item.parentId)
      if (item.databaseId) await requireDatabase(env, item.databaseId, false, auth)
    }
    const saved = await env.DB.prepare(
      'UPDATE data_items SET deleted_at=?,updated_at=?,version=version+1 WHERE id=? AND version=? RETURNING id',
    )
      .bind(action === 'trash' ? nowIso() : null, nowIso(), id, item.version)
      .first()
    if (!saved) fail(409, 'data_conflict', 'Data changed elsewhere. Reload and try again.')
  }
  await writeAudit(env, {
    serverId: auth.serverId,
    actorId: auth.principal.id,
    action: `data.${action}`,
    targetType: 'item',
    targetId: id,
    meta: { title: item.title },
    authorization: auth,
  })
  return { ok: true }
}
