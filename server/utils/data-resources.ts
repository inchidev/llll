import type { CanvasDTO, CanvasEdgeDTO, CanvasNodeDTO, CanvasSummaryDTO, DataBookmarkDTO, DataResourcesDTO, DatabaseSummaryDTO, DatabaseViewSummaryDTO, DocumentSummaryDTO } from '../../shared/types'
import type { AuthorizationContext } from '../../shared/authorization'
import { spaceResourceDenied } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { ITEM_COLUMNS, requireItem, liveItemSql, readableItemSql } from './item-access'

type CanvasRow = Omit<CanvasDTO, 'nodes' | 'edges'>

/** `spaces` is an inline list from `spaceSql`, or `spaceSqlList` for one chosen Space. */
export async function loadDataResources(env: L4Env, userId?: string, spaces?: string, authorization?: AuthorizationContext): Promise<DataResourcesDTO> {
  const visible = readableItemSql(authorization)
  const inSpaces = spaces ? `WHERE space_id IN (${spaces})` : ''
  const andInSpaces = spaces ? `AND space_id IN (${spaces})` : ''
  const [databasesResult, viewsResult, documentsResult, canvasesResult, bookmarksResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, archived_at as archivedAt,
       (SELECT COUNT(*) FROM data_items WHERE database_id = database_definitions.id AND ${visible}) as itemCount
       FROM database_definitions WHERE deleted_at IS NULL ${andInSpaces} ORDER BY position, created_at`,
    ).all<DatabaseSummaryDTO>(),
    env.DB.prepare(
      `SELECT id, database_id as databaseId, name, layout, position
       FROM database_views WHERE deleted_at IS NULL ${spaces ? `AND database_id IN (SELECT id FROM database_definitions ${inSpaces})` : ''} ORDER BY database_id, position, created_at`,
    ).all<DatabaseViewSummaryDTO>(),
    env.DB.prepare(
      `SELECT id, title, position, version, created_by as createdBy,
       created_at as createdAt, updated_at as updatedAt FROM data_items WHERE kind='page' AND database_id IS NULL AND ${visible} ${andInSpaces} ORDER BY position, created_at`,
    ).all<DocumentSummaryDTO>(),
    env.DB.prepare(
      `SELECT id, title, position, version, created_by as createdBy,
       created_at as createdAt, updated_at as updatedAt,
       (SELECT COUNT(*) FROM canvas_nodes WHERE canvas_id = data_items.id) as nodeCount
       FROM data_items WHERE kind='canvas' AND database_id IS NULL AND ${visible} ${andInSpaces} ORDER BY position, created_at`,
    ).all<CanvasSummaryDTO>(),
    userId
      ? env.DB.prepare(
          `SELECT target_type as targetType, target_id as targetId, position, created_at as createdAt
           FROM data_bookmarks WHERE user_id = ? ORDER BY position, created_at`,
        ).bind(userId).all<DataBookmarkDTO>()
      : Promise.resolve({ results: [] as DataBookmarkDTO[] }),
  ])
  const views = viewsResult.results ?? []
  const items = (await env.DB.prepare(`SELECT ${ITEM_COLUMNS.replace('title,content,','title,')} FROM data_items WHERE ${visible} ${andInSpaces} ORDER BY position,created_at,id`).all<import('../../shared/data-items').DataItemSummary>()).results
  return {
    items,
    databases: (databasesResult.results ?? []).map(database => ({
      ...database,
      views: views.filter(view => view.databaseId === database.id),
    })),
    documents: documentsResult.results ?? [],
    canvases: canvasesResult.results ?? [],
    bookmarks: bookmarksResult.results ?? [],
  }
}

export async function requireCanvas(env: L4Env, id: string, authorization?: AuthorizationContext, writable = false): Promise<CanvasRow> {
  const item = authorization ? await requireItem(env, authorization, id, writable) : await env.DB.prepare(`SELECT id,title,kind,position,version,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt FROM data_items WHERE id=? AND ${liveItemSql()}`).bind(id).first<CanvasRow & {kind: string}>()
  if (!item || item.kind !== 'canvas') fail(404, 'not_found', 'Canvas not found')
  return item
}

export async function loadCanvas(env: L4Env, id: string, authorization?: AuthorizationContext): Promise<CanvasDTO> {
  const canvas = await requireCanvas(env, id, authorization)
  const [nodesResult, edgesResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, canvas_id as canvasId, kind, content, x, y, width, height, color, version,
       created_by as createdBy, created_at as createdAt, updated_at as updatedAt
       FROM canvas_nodes WHERE canvas_id = ? ORDER BY created_at`,
    ).bind(id).all<CanvasNodeDTO>(),
    env.DB.prepare(
      `SELECT id, canvas_id as canvasId, from_node_id as fromNodeId, to_node_id as toNodeId,
       created_by as createdBy, created_at as createdAt
       FROM canvas_edges WHERE canvas_id = ? ORDER BY created_at`,
    ).bind(id).all<CanvasEdgeDTO>(),
  ])
  return { ...canvas, nodes: nodesResult.results ?? [], edges: edgesResult.results ?? [] }
}

export async function requireCanvasNode(env: L4Env, id: string, authorization?: AuthorizationContext, writable = false): Promise<CanvasNodeDTO> {
  const node = await env.DB.prepare(
    `SELECT id, canvas_id as canvasId, kind, content, x, y, width, height, color, version,
     created_by as createdBy, created_at as createdAt, updated_at as updatedAt
     FROM canvas_nodes WHERE id = ?`,
  ).bind(id).first<CanvasNodeDTO>()
  if (!node || (authorization && spaceResourceDenied(authorization, 'canvases', node.canvasId))) fail(404, 'not_found', 'Canvas item not found')
  await requireCanvas(env, node.canvasId, authorization, writable)
  return node
}

export async function loadCanvasNode(env: L4Env, id: string): Promise<CanvasNodeDTO | null> {
  return env.DB.prepare(
    `SELECT id, canvas_id as canvasId, kind, content, x, y, width, height, color, version,
     created_by as createdBy, created_at as createdAt, updated_at as updatedAt
     FROM canvas_nodes WHERE id = ?`,
  ).bind(id).first<CanvasNodeDTO>()
}
