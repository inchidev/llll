import { z } from 'zod'
import { nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import type { CanvasDTO } from '../../../shared/types'
import { cf, fail } from '../../utils/cf'
import { requireCanvas } from '../../utils/data-resources'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({ title: z.string().trim().min(1).max(160), version: z.number().int().positive() })

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const canvas = await requireCanvas(env, id)
  if (canvas.version !== body.version) fail(409, 'stale_canvas', 'This canvas changed elsewhere. Reload and try again.')
  if (await env.DB.prepare('SELECT id FROM canvases WHERE id <> ? AND lower(title) = lower(?) LIMIT 1').bind(id, body.title).first()) {
    fail(409, 'duplicate_name', 'A canvas with this title already exists')
  }
  const updated = await env.DB.prepare(
    `UPDATE canvases SET title = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?
     RETURNING id, title, position, version, created_by as createdBy,
     created_at as createdAt, updated_at as updatedAt`,
  ).bind(body.title, nowIso(), id, body.version).first<Omit<CanvasDTO, 'nodes' | 'edges'>>()
  if (!updated) fail(409, 'stale_canvas', 'This canvas changed elsewhere. Reload and try again.')
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'canvas.update', targetType: 'canvas', targetId: id, meta: { fields: ['title'] } })
  return { canvas: updated }
})
