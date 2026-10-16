import { z } from 'zod'
import { newId, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({ name: z.string().trim().min(1).max(80) })

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, workspaceId, Permission.manageDatabases)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const duplicate = await env.DB.prepare(
    'SELECT id FROM database_definitions WHERE lower(name) = lower(?) LIMIT 1',
  ).bind(body.name).first()
  if (duplicate) fail(409, 'duplicate_name', 'A database with this name already exists')
  const positionRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(position), 0) as position FROM database_definitions WHERE archived_at IS NULL',
  ).first<{ position: number }>()
  const id = newId()
  const now = nowIso()
  const database = {
    id,
    name: body.name,
    position: (positionRow?.position ?? 0) + 1024,
    createdBy: actor.user.id,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    fields: [],
    items: [],
  }
  await env.DB.prepare(
    `INSERT INTO database_definitions (id, name, position, created_by, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).bind(id, body.name, database.position, actor.user.id, now, now).run()
  await writeAudit(env, { workspaceId, actorId: actor.user.id, action: 'database.create', targetType: 'database', targetId: id, meta: { name: body.name } })
  return { database }
})
