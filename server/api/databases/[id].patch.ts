import { z } from 'zod'
import { nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf, fail } from '../../utils/cf'
import { requireDatabase } from '../../utils/database-data'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  position: z.number().int().min(0).optional(),
  archived: z.boolean().optional(),
}).refine(body => Object.keys(body).length > 0, 'No changes')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const database = await requireDatabase(env, id)
  if (body.name !== undefined) {
    const duplicate = await env.DB.prepare(
      'SELECT id FROM database_definitions WHERE id <> ? AND lower(name) = lower(?) LIMIT 1',
    ).bind(id, body.name).first()
    if (duplicate) fail(409, 'duplicate_name', 'A database with this name already exists')
  }
  const assignments: string[] = ['updated_at = ?']
  const values: Array<string | number | null> = [nowIso()]
  if (body.name !== undefined) { assignments.push('name = ?'); values.push(body.name) }
  if (body.position !== undefined) { assignments.push('position = ?'); values.push(body.position) }
  if (body.archived !== undefined) { assignments.push('archived_at = ?'); values.push(body.archived ? nowIso() : null) }
  await env.DB.prepare(`UPDATE database_definitions SET ${assignments.join(', ')} WHERE id = ?`).bind(...values, id).run()
  await writeAudit(env, {
    workspaceId: WORKSPACE_ID,
    actorId: actor.user.id,
    action: body.archived === true ? 'database.archive' : body.archived === false ? 'database.restore' : 'database.update',
    targetType: 'database',
    targetId: id,
    meta: { name: database.name, fields: Object.keys(body) },
  })
  return { database: await requireDatabase(env, id) }
})
