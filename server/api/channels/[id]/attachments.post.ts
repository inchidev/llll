import { attachments } from '../../../../drizzle/schema'
import { MAX_ATTACHMENT_BYTES, sniffMime } from '../../../../shared/mime'
import { newId, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { requireChannelMember } from '../../../utils/guards'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { attachmentDto } from '../../../utils/messages'

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const member = await requireChannelMember(event, channelId, Permission.attachFiles)
  const { env } = cf(event)
  const form = await readMultipartFormData(event)
  const file = form?.find((p) => p.name === 'file' && p.data)
  if (!file?.data) fail(400, 'bad_request', 'Missing file')
  if (file.data.byteLength > MAX_ATTACHMENT_BYTES) fail(413, 'too_large', 'File exceeds 10 MB')

  const mime = sniffMime(file.data, file.filename || 'file')
  if (!mime) fail(415, 'unsupported_type', 'File type not allowed')

  const id = newId()
  const safeName = (file.filename || 'file').replace(/[^\w.-]+/g, '_').slice(0, 80)
  const key = `${member.workspaceId}/${channelId}/${id}-${safeName}`
  await requireFiles(env).put(key, file.data, { httpMetadata: { contentType: mime } })

  const db = getDb(env.DB)
  const row = {
    id,
    messageId: null,
    channelId,
    uploaderId: member.user.id,
    r2Key: key,
    filename: safeName,
    contentType: mime,
    sizeBytes: file.data.byteLength,
    width: null,
    height: null,
    createdAt: nowIso(),
  }
  await db.insert(attachments).values(row)
  return { attachment: attachmentDto(row) }
})
