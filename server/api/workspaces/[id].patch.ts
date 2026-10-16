import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { workspace } from '../../../drizzle/schema'
import { nowIso } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { parseBody } from '../../utils/validate'
import { writeAudit } from '../../utils/messages'

const bodySchema = z.object({
  name: z.string().min(1).max(80).optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const member = await requireMember(event, id, Permission.manageWorkspace)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const db = getDb(env.DB)
  if (body.name) {
    await db.update(workspace).set({ name: body.name.trim(), updatedAt: nowIso() }).where(eq(workspace.id, id))
    await writeAudit(env, { workspaceId: id, actorId: member.user.id, action: 'workspace.update', targetType: 'workspace', targetId: id })
  }
  const row = (await db.select().from(workspace).where(eq(workspace.id, id)).limit(1))[0]
  return { workspace: row }
})
