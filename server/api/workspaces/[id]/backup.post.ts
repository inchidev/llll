import { version as packageVersion } from '../../../../package.json'
import { cf, requireFiles, fail, originOk } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { createWorkspaceBackup } from '../../../utils/workspace-backup'

export default defineEventHandler(async (event) => {
  if (!originOk(event)) fail(403, 'bad_origin', 'Invalid request origin')
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can download backups')

  const { env } = cf(event)
  requireFiles(env)
  const createdAt = new Date().toISOString()
  const version = env.LLLL_VERSION?.trim() || packageVersion
  await writeAudit(env, {
    workspaceId,
    actorId: member.user.id,
    action: 'backup.download',
    targetType: 'workspace',
    targetId: workspaceId,
    meta: { format: 'llll-tar-v1', version },
  })

  const stamp = createdAt.replaceAll(':', '-').replace('.000Z', 'Z')
  setHeader(event, 'Content-Type', 'application/x-tar')
  setHeader(event, 'Content-Disposition', `attachment; filename="llll-backup-${stamp}.tar"`)
  setHeader(event, 'Cache-Control', 'no-store, max-age=0')
  setHeader(event, 'Cross-Origin-Resource-Policy', 'same-origin')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return createWorkspaceBackup(env, createdAt, version)
})
