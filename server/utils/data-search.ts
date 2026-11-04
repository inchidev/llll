import { authorize, resourceAllowed, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import type { DataSearchHit } from '../../shared/data-search'
import { readableItemSql } from './item-access'
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
  const rows = (await env.DB.prepare(`SELECT id,title,COALESCE(database_id,id) AS resourceId FROM data_items WHERE ${readableItemSql(auth)} AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 20`).bind(pattern,pattern).all<Omit<DataSearchHit,'type'>>()).results
  hits.push(...rows.map(row=>({...row,type:'item' as const})))
  try {
    authorize(auth, ServerAction.readRecords)
    const databases = (await env.DB.prepare(`SELECT id,name AS title,id AS resourceId FROM database_definitions WHERE deleted_at IS NULL AND space_id IN (${spaces}) AND name LIKE ? ESCAPE '\\' ORDER BY name`).bind(pattern).all<Omit<DataSearchHit,'type'>>()).results
    hits.push(...databases.filter(row=>resourceAllowed(auth,'databases',row.id)).slice(0,20).map(row=>({...row,type:'database' as const})))
  } catch (error) { if (Number((error as {statusCode?:number}).statusCode)!==403) throw error }
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
