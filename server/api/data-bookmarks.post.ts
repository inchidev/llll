import { z } from 'zod'
import type { DataBookmarkDTO } from '../../shared/types'
import { WORKSPACE_ID } from '../../shared/ids'
import { Permission } from '../../shared/permissions'
import { cf } from '../utils/cf'
import { requireCanvas, requireDocument } from '../utils/data-resources'
import { requireDatabase } from '../utils/database-data'
import { requireDatabaseView } from '../utils/database-views'
import { requireMember } from '../utils/guards'
import { parseBody } from '../utils/validate'

const bodySchema = z.object({ targetType: z.enum(['database_view', 'document', 'canvas']), targetId: z.string().min(1) })

export default defineEventHandler(async (event): Promise<{ bookmark: DataBookmarkDTO }> => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  if (body.targetType === 'database_view') {
    const view = await requireDatabaseView(env, body.targetId)
    await requireDatabase(env, view.databaseId, true)
  }
  else if (body.targetType === 'document') await requireDocument(env, body.targetId)
  else await requireCanvas(env, body.targetId)
  const position = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) + 1024 as value FROM data_bookmarks WHERE user_id = ?')
    .bind(actor.user.id).first<{ value: number }>()
  await env.DB.prepare(
    `INSERT INTO data_bookmarks (user_id, target_type, target_id, position)
     VALUES (?, ?, ?, ?) ON CONFLICT(user_id, target_type, target_id) DO NOTHING`,
  ).bind(actor.user.id, body.targetType, body.targetId, position?.value ?? 1024).run()
  const bookmark = await env.DB.prepare(
    `SELECT target_type as targetType, target_id as targetId, position, created_at as createdAt
     FROM data_bookmarks WHERE user_id = ? AND target_type = ? AND target_id = ?`,
  ).bind(actor.user.id, body.targetType, body.targetId).first<DataBookmarkDTO>()
  return { bookmark: bookmark! }
})
