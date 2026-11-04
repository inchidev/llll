import type { z } from 'zod'
import {
  createItemSchema,
  updateItemSchema,
  moveItemSchema,
  type DataItem,
  type DataItemSummary,
  type DataItemDetail,
} from '../../shared/data-items'
import {
  authorize,
  authorizeResource,
  resourceAllowed,
  ServerAction,
  type AuthorizationContext,
} from '../../shared/authorization'
import { creationSpaceId } from '../../shared/spaces'
import { newId, nowIso } from '../../shared/ids'
import { DatabaseStorageTypes, databaseSlots } from '../../shared/database'
import type { L4Env } from '../../workers/env'
import { ITEM_COLUMNS, authorizeItem, liveItemSql, readableItemSql, requireItem } from './item-access'
import {
  requireDatabase,
  databaseFieldsFor,
  databaseFieldDto,
  loadDatabaseItem,
  loadItemLinks,
  loadLinkedRecords,
} from './database-data'
import { documentInputHtml } from './document-content'
import { writeAudit } from './messages'
import { fail } from './cf'

export async function listItems(env: L4Env, auth: AuthorizationContext, parentId?: string): Promise<DataItemSummary[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT ${ITEM_COLUMNS.replace('title,content,', 'title,')} FROM data_items WHERE ${readableItemSql(auth)} ${parentId === undefined ? '' : 'AND parent_id=?'} ORDER BY position,created_at,id`,
    )
      .bind(...(parentId === undefined ? [] : [parentId]))
      .all<DataItemSummary>()
  ).results
  return rows
}
export async function getItem(env: L4Env, auth: AuthorizationContext, id: string): Promise<DataItemDetail> {
  const item = await requireItem(env, auth, id)
  const fields = item.databaseId ? await databaseFieldsFor(env, item.databaseId) : []
  const record = item.databaseId ? await loadDatabaseItem(env, id) : null
  const children = await listItems(env, auth, id)
  const linked = item.databaseId
    ? await loadLinkedRecords(env, await loadItemLinks(env, [id]), (db) => resourceAllowed(auth, 'databases', db), auth)
    : {}
  return { ...item, linked, fields: fields.map(databaseFieldDto), values: record?.values ?? {}, children }
}
async function destination(
  env: L4Env,
  auth: AuthorizationContext,
  spaceId: string,
  parentId: string | null,
  databaseId: string | null,
) {
  if (parentId) {
    const parent = await requireItem(env, auth, parentId, true)
    authorizeItem(auth, parent)
    if (parent.spaceId !== spaceId) fail(404, 'not_found', 'Parent not found')
  }
  if (databaseId) {
    await requireDatabase(env, databaseId, true, auth)
    const db = await env.DB.prepare('SELECT space_id AS spaceId FROM database_definitions WHERE id=?')
      .bind(databaseId)
      .first<{ spaceId: string }>()
    if (db?.spaceId !== spaceId) fail(404, 'not_found', 'Database not found')
    authorize(auth, ServerAction.writeRecords)
    authorizeResource(auth, 'databases', databaseId)
  }
}
export async function createItem(
  env: L4Env,
  auth: AuthorizationContext,
  input: z.input<typeof createItemSchema>,
): Promise<DataItemDetail> {
  const body = createItemSchema.parse(input)
  const spaceId = creationSpaceId(auth)
  if (!spaceId) fail(403, 'forbidden', 'Choose a Space first')
  // A Canvas takes what creating a resource takes; a page only takes write access.
  if (body.kind === 'canvas') authorize(auth, ServerAction.manageData)
  const databaseId = body.databaseId ?? null,
    parentId = body.parentId ?? null
  await destination(env, auth, spaceId, parentId, databaseId)
  if (!databaseId) {
    authorize(auth, ServerAction.writeDocuments)
    authorizeResource(auth, body.kind === 'canvas' ? 'canvases' : 'documents', '*')
  }
  const id = newId(),
    now = nowIso()
  // The response includes current content; reject missing read grants before committing a write.
  authorizeItem(auth, { id, kind: body.kind, databaseId })
  const content = documentInputHtml(body.content ?? '', body.format)
  await env.DB.prepare(
    `INSERT INTO data_items(id,space_id,kind,parent_id,database_id,title,content,icon,position,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1024 FROM data_items WHERE space_id=?),?,?,?)`,
  )
    .bind(
      id,
      spaceId,
      body.kind,
      parentId,
      databaseId,
      body.title ?? 'Untitled',
      content,
      body.icon ?? null,
      spaceId,
      auth.principal.id,
      now,
      now,
    )
    .run()
  await writeAudit(env, {
    serverId: auth.serverId,
    actorId: auth.principal.id,
    action: 'item.create',
    targetType: 'item',
    targetId: id,
    meta: { kind: body.kind },
    authorization: auth,
  })
  return getItem(env, auth, id)
}
export async function updateItem(
  env: L4Env,
  auth: AuthorizationContext,
  id: string,
  input: z.input<typeof updateItemSchema>,
): Promise<DataItem> {
  const body = updateItemSchema.parse(input)
  await requireItem(env, auth, id, true)
  const assignments = ['version=version+1', 'updated_at=?'],
    values: (string | number | null)[] = [nowIso()]
  for (const key of ['title', 'content', 'icon'] as const)
    if (body[key] !== undefined) {
      assignments.push(`${key}=?`)
      values.push(key === 'content' ? documentInputHtml(body.content!, body.format) : body[key]!)
    }
  const updated = await env.DB.prepare(
    `UPDATE data_items SET ${assignments.join(',')} WHERE id=? AND version=? AND ${liveItemSql()} RETURNING ${ITEM_COLUMNS}`,
  )
    .bind(...values, id, body.version)
    .first<DataItem>()
  if (!updated) fail(409, 'stale_item', 'This page changed elsewhere. Reload and try again.')
  await writeAudit(env, {
    serverId: auth.serverId,
    actorId: auth.principal.id,
    action: 'item.update',
    targetType: 'item',
    targetId: id,
    meta: { fields: Object.keys(body).filter((key) => key !== 'version') },
    authorization: auth,
  })
  return updated
}
export async function moveItem(
  env: L4Env,
  auth: AuthorizationContext,
  id: string,
  input: z.input<typeof moveItemSchema>,
) {
  const body = moveItemSchema.parse(input)
  authorize(auth, ServerAction.manageData)
  const item = await requireItem(env, auth, id, true)
  const parentId = body.parentId === undefined ? item.parentId : body.parentId
  const databaseId = body.databaseId === undefined ? item.databaseId : body.databaseId
  await destination(env, auth, item.spaceId, parentId, databaseId)
  authorizeItem(auth, { ...item, databaseId })
  if (!databaseId && item.databaseId) {
    authorize(auth, ServerAction.writeDocuments)
    authorizeResource(auth, item.kind === 'canvas' ? 'canvases' : 'documents', '*')
  }
  if (parentId) {
    const cycle = await env.DB.prepare(
      `WITH RECURSIVE descendants(id) AS (SELECT id FROM data_items WHERE id=? UNION SELECT i.id FROM data_items i JOIN descendants d ON i.parent_id=d.id) SELECT id FROM descendants WHERE id=?`,
    )
      .bind(id, parentId)
      .first()
    if (cycle) fail(400, 'item_cycle', 'A page cannot be nested inside itself or its children')
  }
  const changed = databaseId !== item.databaseId
  if (changed && item.databaseId && !body.discardProperties)
    fail(
      409,
      'properties_confirmation',
      'Changing database removes the old property values and relation links. Confirm before moving.',
    )
  const slots = changed ? DatabaseStorageTypes.flatMap((type) => databaseSlots(type)).map((slot) => `${slot}=NULL`) : []
  const mutation = newId()
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE data_items SET parent_id=?,database_id=?,mutation_id=?,version=version+1,updated_at=?${slots.length ? ',' + slots.join(',') : ''} WHERE id=? AND version=? AND ${liveItemSql()} RETURNING id`,
    ).bind(parentId, databaseId, mutation, nowIso(), id, body.version),
    ...(changed
      ? [
          env.DB.prepare(
            'DELETE FROM database_item_links WHERE (item_id=? OR target_item_id=?) AND EXISTS(SELECT 1 FROM data_items WHERE id=? AND mutation_id=?)',
          ).bind(id, id, id, mutation),
        ]
      : []),
  ])
  if (!result[0]?.results.length) fail(409, 'stale_item', 'This page changed elsewhere. Reload and try again.')
  await writeAudit(env, {
    serverId: auth.serverId,
    actorId: auth.principal.id,
    action: 'item.move',
    targetType: 'item',
    targetId: id,
    meta: { parentId, databaseId },
    authorization: auth,
  })
  return getItem(env, auth, id)
}
