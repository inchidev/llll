import { z } from 'zod'
import { requireMailboxPermission } from '../../../../utils/server-mail'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
import { discardMailUploadStatements } from '../../../../utils/mail-attachments'
import { retryMailFileCleanup } from '../../../../utils/mail-cleanup'

const schema = z.object({ attachmentId: z.string().trim().min(1).max(80) })

/** Removes one of your own unsent uploads. Files on sent email stay with the conversation. */
export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const mailboxId = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, mailboxId, 'send')
  const { attachmentId } = parseBody(schema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const row = await env.DB.prepare('SELECT 1 AS found FROM attachments WHERE id = ? AND channel_id = ? AND uploader_id = ? AND message_id IS NULL')
    .bind(attachmentId, access.mailboxId, access.user.id).first()
  if (!row) fail(404, 'not_found', 'Attachment not found')
  await env.DB.batch(discardMailUploadStatements(env, [attachmentId], access.user.id))
  waitUntil(retryMailFileCleanup(env))
  return { ok: true }
})
