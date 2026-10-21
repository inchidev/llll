import type { AuthorizationContext } from '../../shared/authorization'
import { authorizeResource } from '../../shared/authorization'
import type { ResourceKind } from '../../shared/resource-access'
import type { L4Env } from '../../workers/env'

/** Explicit HTTP resource map; nested objects inherit their owning collection policy. */
export async function authorizeResourceRequest(env: L4Env, authorization: AuthorizationContext, path: string): Promise<void> {
  const direct = path.match(/^\/api\/(databases|documents|canvases|boards)\/([^/]+)(?:\/|$)/u)
  if (direct) authorizeResource(authorization, direct[1] as ResourceKind, decodeURIComponent(direct[2]!))
  const create = path.match(/^\/api\/servers\/[^/]+\/(databases|documents|canvases|boards)(?:\/reorder)?$/u)
  if (create) authorizeResource(authorization, create[1] as ResourceKind, '*')
  const nested = path.match(/^\/api\/(database-items|database-fields|database-views|canvas-nodes|canvas-edges)\/([^/]+)(?:\/|$)/u)
  if (!nested) return
  const sources = {
    'database-items': ['database_items', 'database_id', 'databases'],
    'database-fields': ['database_fields', 'database_id', 'databases'],
    'database-views': ['database_views', 'database_id', 'databases'],
    'canvas-nodes': ['canvas_nodes', 'canvas_id', 'canvases'],
    'canvas-edges': ['canvas_edges', 'canvas_id', 'canvases'],
  } as const
  const source = sources[nested[1] as keyof typeof sources]
  if (!source) return
  const row = await env.DB.prepare(`SELECT ${source[1]} as resourceId FROM ${source[0]} WHERE id = ?`)
    .bind(decodeURIComponent(nested[2]!)).first<{ resourceId: string }>()
  if (row) authorizeResource(authorization, source[2], row.resourceId)
}
