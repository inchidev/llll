import { z } from 'zod'
import { newId, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({ title: z.string().trim().min(1).max(160) })

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, workspaceId, Permission.manageDatabases)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  if (await env.DB.prepare('SELECT id FROM canvases WHERE lower(title) = lower(?) LIMIT 1').bind(body.title).first()) {
    fail(409, 'duplicate_name', 'A canvas with this title already exists')
  }
  const position = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) + 1024 as value FROM canvases').first<{ value: number }>()
  const id = newId()
  const now = nowIso()
  await env.DB.prepare(
    `INSERT INTO canvases (id, title, position, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  ).bind(id, body.title, position?.value ?? 1024, actor.user.id, now, now).run()
  await writeAudit(env, { workspaceId, actorId: actor.user.id, action: 'canvas.create', targetType: 'canvas', targetId: id, meta: { title: body.title } })
  return { canvas: { id, title: body.title, position: position?.value ?? 1024, version: 1, createdBy: actor.user.id, createdAt: now, updatedAt: now, nodes: [], edges: [] } }
})
