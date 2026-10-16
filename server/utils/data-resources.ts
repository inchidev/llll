import type { CanvasDTO, CanvasEdgeDTO, CanvasNodeDTO, CanvasSummaryDTO, DataBookmarkDTO, DataResourcesDTO, DatabaseSummaryDTO, DatabaseViewSummaryDTO, DocumentDTO, DocumentSummaryDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'

type CanvasRow = Omit<CanvasDTO, 'nodes' | 'edges'>

export async function loadDataResources(env: L4Env, userId?: string): Promise<DataResourcesDTO> {
  const [databasesResult, viewsResult, documentsResult, canvasesResult, bookmarksResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, archived_at as archivedAt,
       (SELECT COUNT(*) FROM database_items WHERE database_id = database_definitions.id) as itemCount
       FROM database_definitions ORDER BY position, created_at`,
    ).all<DatabaseSummaryDTO>(),
    env.DB.prepare(
      `SELECT id, database_id as databaseId, name, layout, position
       FROM database_views ORDER BY database_id, position, created_at`,
    ).all<DatabaseViewSummaryDTO>(),
    env.DB.prepare(
      `SELECT id, title, position, version, created_by as createdBy,
       created_at as createdAt, updated_at as updatedAt FROM documents ORDER BY position, created_at`,
    ).all<DocumentSummaryDTO>(),
    env.DB.prepare(
      `SELECT id, title, position, version, created_by as createdBy,
       created_at as createdAt, updated_at as updatedAt,
       (SELECT COUNT(*) FROM canvas_nodes WHERE canvas_id = canvases.id) as nodeCount
       FROM canvases ORDER BY position, created_at`,
    ).all<CanvasSummaryDTO>(),
    userId
      ? env.DB.prepare(
          `SELECT target_type as targetType, target_id as targetId, position, created_at as createdAt
           FROM data_bookmarks WHERE user_id = ? ORDER BY position, created_at`,
        ).bind(userId).all<DataBookmarkDTO>()
      : Promise.resolve({ results: [] as DataBookmarkDTO[] }),
  ])
  const views = viewsResult.results ?? []
  return {
    databases: (databasesResult.results ?? []).map(database => ({
      ...database,
      views: views.filter(view => view.databaseId === database.id),
    })),
    documents: documentsResult.results ?? [],
    canvases: canvasesResult.results ?? [],
    bookmarks: bookmarksResult.results ?? [],
  }
}

export async function requireDocument(env: L4Env, id: string): Promise<DocumentDTO> {
  const document = await env.DB.prepare(
    `SELECT id, title, content, position, version, created_by as createdBy,
     created_at as createdAt, updated_at as updatedAt FROM documents WHERE id = ?`,
  ).bind(id).first<DocumentDTO>()
  if (!document) fail(404, 'not_found', 'Document not found')
  return document
}

export async function requireCanvas(env: L4Env, id: string): Promise<CanvasRow> {
  const canvas = await env.DB.prepare(
    `SELECT id, title, position, version, created_by as createdBy,
     created_at as createdAt, updated_at as updatedAt FROM canvases WHERE id = ?`,
  ).bind(id).first<CanvasRow>()
  if (!canvas) fail(404, 'not_found', 'Canvas not found')
  return canvas
}

export async function loadCanvas(env: L4Env, id: string): Promise<CanvasDTO> {
  const canvas = await requireCanvas(env, id)
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

export async function requireCanvasNode(env: L4Env, id: string): Promise<CanvasNodeDTO> {
  const node = await env.DB.prepare(
    `SELECT id, canvas_id as canvasId, kind, content, x, y, width, height, color, version,
     created_by as createdBy, created_at as createdAt, updated_at as updatedAt
     FROM canvas_nodes WHERE id = ?`,
  ).bind(id).first<CanvasNodeDTO>()
  if (!node) fail(404, 'not_found', 'Canvas item not found')
  return node
}

export async function loadCanvasNode(env: L4Env, id: string): Promise<CanvasNodeDTO | null> {
  return env.DB.prepare(
    `SELECT id, canvas_id as canvasId, kind, content, x, y, width, height, color, version,
     created_by as createdBy, created_at as createdAt, updated_at as updatedAt
     FROM canvas_nodes WHERE id = ?`,
  ).bind(id).first<CanvasNodeDTO>()
}
