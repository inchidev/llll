import { version as packageVersion } from '../../../../package.json'
import { cf, requireFiles, fail, originOk } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { createServerBackup } from '../../../utils/server-backup'

export default defineEventHandler(async (event) => {
  if (!await originOk(event)) fail(403, 'bad_origin', 'Invalid request origin')
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can download backups')

  const { env } = cf(event)
  requireFiles(env)
  const createdAt = new Date().toISOString()
  const version = env.LLLL_VERSION?.trim() || packageVersion
  await writeAudit(env, {
    serverId,
    actorId: member.user.id,
    action: 'backup.download',
    targetType: 'server',
    targetId: serverId,
    meta: { format: 'llll-tar-v1', version },
  })

  const stamp = createdAt.replaceAll(':', '-').replace('.000Z', 'Z')
  setHeader(event, 'Content-Type', 'application/x-tar')
  setHeader(event, 'Content-Disposition', `attachment; filename="llll-backup-${stamp}.tar"`)
  setHeader(event, 'Cache-Control', 'no-store, max-age=0')
  setHeader(event, 'Cross-Origin-Resource-Policy', 'same-origin')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return createServerBackup(env, createdAt, version)
})
