import { eq } from 'drizzle-orm'
import { workspace } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { extForMime, sniffMime } from '../../../../shared/mime'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'

const MAX_WORKSPACE_ICON_BYTES = 2 * 1024 * 1024

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId, Permission.manageWorkspace)
  const { env } = cf(event)
  const form = await readMultipartFormData(event)
  const file = form?.find(part => part.name === 'file' && part.data)
  if (!file?.data) fail(400, 'bad_request', 'Missing image')
  if (file.data.byteLength > MAX_WORKSPACE_ICON_BYTES) fail(413, 'too_large', 'Workspace icon exceeds 2 MB')
  const mime = sniffMime(file.data, file.filename || 'icon')
  if (!mime?.startsWith('image/')) fail(415, 'unsupported_type', 'Workspace icon must be PNG, JPEG, WebP, or GIF')

  const db = getDb(env.DB)
  const current = (await db.select({ iconR2Key: workspace.iconR2Key }).from(workspace)
    .where(eq(workspace.id, workspaceId)).limit(1))[0]
  if (!current) fail(404, 'not_found', 'Workspace not found')
  const key = `${workspaceId}/workspace/icon-${newId()}.${extForMime(mime)}`
  await requireFiles(env).put(key, file.data, { httpMetadata: { contentType: mime } })
  await db.update(workspace).set({ iconR2Key: key, updatedAt: nowIso() }).where(eq(workspace.id, workspaceId))
  if (current.iconR2Key) await requireFiles(env).delete(current.iconR2Key)
  await writeAudit(env, {
    workspaceId,
    actorId: member.user.id,
    action: 'workspace.icon.update',
    targetType: 'workspace',
    targetId: workspaceId,
  })
  const updated = (await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1))[0]
  return { workspace: updated }
})
