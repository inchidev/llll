import { eq } from 'drizzle-orm'
import { workspace } from '../../../../drizzle/schema'
import { nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId, Permission.manageWorkspace)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const current = (await db.select({ iconR2Key: workspace.iconR2Key }).from(workspace)
    .where(eq(workspace.id, workspaceId)).limit(1))[0]
  if (!current) fail(404, 'not_found', 'Workspace not found')
  await db.update(workspace).set({ iconR2Key: null, updatedAt: nowIso() }).where(eq(workspace.id, workspaceId))
  if (current.iconR2Key) await requireFiles(env).delete(current.iconR2Key)
  await writeAudit(env, {
    workspaceId,
    actorId: member.user.id,
    action: 'workspace.icon.delete',
    targetType: 'workspace',
    targetId: workspaceId,
  })
  return { ok: true }
})
