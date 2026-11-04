import { authorize, resourceAllowed, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import type { DataSearchHit } from '../../shared/data-search'
import { visibleDataReference } from './data-references'
import { taskPermissionAllowed } from './task-policy'
import { Permission } from '../../shared/permissions'
import { spaceSql } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'

export async function searchData(env: L4Env, auth: AuthorizationContext, query: string): Promise<DataSearchHit[]> {
  const term = query.trim().slice(0, 200)
  if (term.length < 2) return []
  const pattern = `%${term.replace(/[\\%_]/gu, value => `\\${value}`)}%`
  const hits: DataSearchHit[] = []
  // The Space comes first, so another Space's matches cannot use up LIMIT.
  const spaces = spaceSql(auth)
  const sources = [
    { type: 'document', action: ServerAction.readDocuments, resource: 'documents', sql: `SELECT id,title,id as resourceId FROM documents WHERE deleted_at IS NULL AND space_id IN (${spaces}) AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY updated_at DESC`, params: [pattern, pattern] },
    { type: 'database', action: ServerAction.readRecords, resource: 'databases', sql: `SELECT id,name as title,id as resourceId FROM database_definitions WHERE deleted_at IS NULL AND space_id IN (${spaces}) AND name LIKE ? ESCAPE '\\' ORDER BY name`, params: [pattern] },
    { type: 'record', action: ServerAction.readRecords, resource: 'databases', sql: `SELECT id,title,database_id as resourceId FROM database_items WHERE deleted_at IS NULL AND database_id IN (SELECT id FROM database_definitions WHERE deleted_at IS NULL AND space_id IN (${spaces})) AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC`, params: [pattern] },
    { type: 'canvas', action: ServerAction.readDocuments, resource: 'canvases', sql: `SELECT id,title,id as resourceId FROM canvases WHERE deleted_at IS NULL AND space_id IN (${spaces}) AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC`, params: [pattern] },
  ] as const
  for (const source of sources) {
    try { authorize(auth, source.action) } catch { continue }
    const principalLimit = auth.principal.isOwner ? null : auth.principal.resourceAccess?.[source.resource]
    const delegatedLimit = auth.delegation?.resourceAccess?.[source.resource]
    const limit = principalLimit ?? delegatedLimit
    const allowed = limit?.filter(id => resourceAllowed(auth, source.resource, id))
    const [selection, order] = source.sql.split(' ORDER BY ')
    const rows = (await env.DB.prepare(`${selection}${allowed ? ' AND resourceId IN (SELECT value FROM json_each(?))' : ''} ORDER BY ${order} LIMIT 20`).bind(...source.params, ...(allowed ? [JSON.stringify(allowed)] : [])).all<Omit<DataSearchHit, 'type'>>()).results
    hits.push(...rows.map(row => ({ ...row, type: source.type })))
  }
  let taskHits = 0
  for (let offset = 0; taskHits < 20; offset += 100) {
    const tasks = (await env.DB.prepare(`SELECT id,board_id AS boardId,project_id AS projectId FROM tasks WHERE archived_at IS NULL AND board_id IN (SELECT id FROM task_boards WHERE space_id IN (${spaces})) AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC,id LIMIT 100 OFFSET ?`).bind(pattern, offset).all<{ id: string; boardId: string; projectId: string | null }>()).results
    for (const task of tasks) {
      if (!taskPermissionAllowed(auth, task, Permission.readTasks)) continue
      const hit = await visibleDataReference(env, auth, 'task', task.id)
      if (hit) { hits.push(hit); taskHits++ }
      if (taskHits === 20) break
    }
    if (tasks.length < 100) break
  }
  return hits
}
