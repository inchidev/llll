import { z } from 'zod'
import type { AttachmentDTO } from '../../../../../shared/types'
import { fileStorage } from '../../../../../shared/file-storage'
import { requireMailboxPermission } from '../../../../utils/server-mail'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
import { mailboxAttachment, requireMailFiles, storeMailUpload, sweepMailUploads } from '../../../../utils/mail-attachments'
import { requireRate, UPLOAD_BYTES_PER_HOUR, uploadRate } from '../../../../utils/message-service'

const forward = z.object({ forwardAttachmentId: z.string().trim().min(1).max(80) })

/**
 * Adds one file to an email or draft in this mailbox: a multipart `file`, or a
 * JSON `forwardAttachmentId` copying a file from an email in this mailbox. The
 * type is read from the bytes, never from the browser.
 */
export default defineEventHandler(async (event): Promise<{ attachment: AttachmentDTO }> => {
  const mailboxId = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, mailboxId, 'send')
  if (access.channel.type !== 'text') fail(404, 'not_found', 'Mailbox not found')
  const { env, waitUntil } = cf(event)
  requireMailFiles(env)
  let bytes: Uint8Array, filename: string | undefined
  if (/^multipart\//iu.test(getHeader(event, 'content-type') ?? '')) {
    const file = (await readMultipartFormData(event))?.find(part => part.name === 'file' && part.data)
    if (!file?.data) fail(400, 'bad_request', 'Missing file')
    bytes = new Uint8Array(file.data)
    filename = file.filename
  }
  else {
    const source = await mailboxAttachment(env, mailboxId, parseBody(forward, await readBody(event)).forwardAttachmentId)
    const object = source ? await fileStorage(env).get(source.r2Key) : null
    if (!source || !object) fail(404, 'not_found', 'Attachment not found')
    bytes = new Uint8Array(await object.arrayBuffer())
    filename = source.filename
  }
  await requireRate(env, uploadRate(access.user.id), 'Too many uploads. Try again in a few minutes.')
  const since = new Date(Date.now() - 60 * 60_000).toISOString()
  const recent = await env.DB.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM attachments WHERE uploader_id = ? AND created_at > ?')
    .bind(access.user.id, since).first<{ bytes: number }>()
  if ((recent?.bytes ?? 0) + bytes.byteLength > UPLOAD_BYTES_PER_HOUR) fail(429, 'rate_limited', 'Upload limit reached. Try again later.')
  waitUntil(sweepMailUploads(env, mailboxId, access.user.id).catch(() => {}))
  return { attachment: await storeMailUpload(env, { serverId: access.serverId, mailboxId, userId: access.user.id, bytes, filename }) }
})
