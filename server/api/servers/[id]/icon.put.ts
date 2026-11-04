import { eq } from 'drizzle-orm'
import { server } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { extForMime, sniffMime } from '../../../../shared/mime'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'

const MAX_SERVER_ICON_BYTES = 2 * 1024 * 1024

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId, Permission.manageServer)
  const { env } = cf(event)
  const form = await readMultipartFormData(event)
  const file = form?.find(part => part.name === 'file' && part.data)
  if (!file?.data) fail(400, 'bad_request', 'Missing image')
  if (file.data.byteLength > MAX_SERVER_ICON_BYTES) fail(413, 'too_large', 'Server icon exceeds 2 MB')
  const mime = sniffMime(file.data, file.filename || 'icon')
  if (!mime?.startsWith('image/')) fail(415, 'unsupported_type', 'Server icon must be PNG, JPEG, WebP, or GIF')

  const db = getDb(env.DB)
  const current = (await db.select({ iconR2Key: server.iconR2Key }).from(server)
    .where(eq(server.id, serverId)).limit(1))[0]
  if (!current) fail(404, 'not_found', 'Server not found')
  const key = `${serverId}/server/icon-${newId()}.${extForMime(mime)}`
  await requireFiles(env).put(key, file.data, { httpMetadata: { contentType: mime } })
  await db.update(server).set({ iconR2Key: key, updatedAt: nowIso() }).where(eq(server.id, serverId))
  if (current.iconR2Key) await requireFiles(env).delete(current.iconR2Key)
  await writeAudit(env, {
    serverId,
    actorId: member.user.id,
    action: 'server.icon.update',
    targetType: 'server',
    targetId: serverId,
  })
  const updated = (await db.select().from(server).where(eq(server.id, serverId)).limit(1))[0]
  return { server: updated }
})
