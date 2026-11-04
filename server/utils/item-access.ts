import { authorize, authorizeResource, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { spaceSql } from '../../shared/spaces'
import type { DataItem } from '../../shared/data-items'
import type { L4Env } from '../../workers/env'
import { sanitizeDocumentHtml } from './document-content'
import { fail } from './cf'

export const ITEM_COLUMNS = `id,space_id AS spaceId,kind,parent_id AS parentId,database_id AS databaseId,
  title,content,icon,position,version,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt`

/** Ancestor trash and collection trash hide every entry point, including search and relation chips. */
export function liveItemSql(alias = 'data_items'): string {
  return `${alias}.deleted_at IS NULL AND NOT EXISTS (
    WITH RECURSIVE ancestors(id,parent_id,database_id,deleted_at) AS (
      SELECT ${alias}.id,${alias}.parent_id,${alias}.database_id,${alias}.deleted_at
      UNION SELECT p.id,p.parent_id,p.database_id,p.deleted_at FROM data_items p JOIN ancestors a ON p.id=a.parent_id
    ) SELECT 1 FROM ancestors a LEFT JOIN database_definitions d ON d.id=a.database_id
      WHERE a.deleted_at IS NOT NULL OR (a.database_id IS NOT NULL AND (d.id IS NULL OR d.deleted_at IS NOT NULL)))`
}
export function itemResource(item: Pick<DataItem, 'id' | 'kind' | 'databaseId'>) {
  return item.databaseId
    ? { kind: 'databases' as const, id: item.databaseId }
    : { kind: item.kind === 'canvas' ? ('canvases' as const) : ('documents' as const), id: item.id }
}
export function authorizeItem(
  auth: AuthorizationContext,
  item: Pick<DataItem, 'id' | 'kind' | 'databaseId'>,
  write = false,
) {
  authorize(
    auth,
    item.databaseId
      ? write
        ? ServerAction.writeRecords
        : ServerAction.readRecords
      : write
        ? ServerAction.writeDocuments
        : ServerAction.readDocuments,
  )
  const resource = itemResource(item)
  authorizeResource(auth, resource.kind, resource.id)
}
export async function requireItem(
  env: L4Env,
  auth: AuthorizationContext,
  id: string,
  write = false,
  includeTrash = false,
): Promise<DataItem> {
  const item = await env.DB.prepare(
    `SELECT ${ITEM_COLUMNS} FROM data_items WHERE id=? AND space_id IN (${spaceSql(auth)}) ${includeTrash ? '' : `AND ${liveItemSql()}`}`,
  )
    .bind(id)
    .first<DataItem>()
  if (!item) fail(404, 'not_found', 'Item not found')
  authorizeItem(auth, item, write)
  // Nesting never grants access to the containing page or any of its children.
  const parents = (
    await env.DB.prepare(
      `WITH RECURSIVE parents AS (
    SELECT id,parent_id,kind,database_id,space_id FROM data_items WHERE id=?
    UNION SELECT p.id,p.parent_id,p.kind,p.database_id,p.space_id FROM data_items p JOIN parents a ON p.id=a.parent_id
  ) SELECT id,kind,database_id AS databaseId FROM parents WHERE id<>?`,
    )
      .bind(id, id)
      .all<Pick<DataItem, 'id' | 'kind' | 'databaseId'>>()
  ).results
  for (const parent of parents) authorizeItem(auth, parent)
  if (write && item.databaseId) {
    const db = await env.DB.prepare('SELECT archived_at AS archivedAt FROM database_definitions WHERE id=?')
      .bind(item.databaseId)
      .first<{ archivedAt: string | null }>()
    if (db?.archivedAt) fail(409, 'database_archived', 'Restore the database before changing it')
  }
  return { ...item, content: sanitizeDocumentHtml(item.content) }
}

/** SQL twin of authorizeItem for lists: filter before counts, pagination and title disclosure. */
export function readableItemSql(auth?: AuthorizationContext, alias = 'data_items'): string {
  return auth ? `${liveItemSql(alias)} AND ${permittedItemSql(auth, alias)}` : liveItemSql(alias)
}
/** requireItem's read check as SQL, live or in Trash: its Space, and it and every ancestor readable. */
export function permittedItemSql(auth: AuthorizationContext, alias = 'data_items'): string {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
  const allowed = (kind: 'databases' | 'documents' | 'canvases', column: string, action: ServerAction) => {
    try {
      authorize(auth, action)
    } catch {
      return '0'
    }
    const rules: string[] = []
    for (const access of [
      auth.principal.isOwner ? undefined : auth.principal.resourceAccess,
      auth.delegation?.resourceAccess,
    ]) {
      const ids = access?.[kind]
      if (ids != null) rules.push(ids.length ? `${column} IN (${ids.map(literal).join(',')})` : '0')
    }
    return rules.length ? rules.join(' AND ') : '1'
  }
  const permitted = `CASE WHEN a.database_id IS NOT NULL THEN (${allowed('databases', 'a.database_id', ServerAction.readRecords)})
    WHEN a.kind='canvas' THEN (${allowed('canvases', 'a.id', ServerAction.readDocuments)}) ELSE (${allowed('documents', 'a.id', ServerAction.readDocuments)}) END`
  return `${alias}.space_id IN (${spaceSql(auth)}) AND NOT EXISTS (
    WITH RECURSIVE ancestors(id,parent_id,database_id,kind) AS (SELECT ${alias}.id,${alias}.parent_id,${alias}.database_id,${alias}.kind
      UNION SELECT p.id,p.parent_id,p.database_id,p.kind FROM data_items p JOIN ancestors a ON p.id=a.parent_id)
    SELECT 1 FROM ancestors a WHERE NOT (${permitted}))`
}
