import { z } from 'zod'
import { newId, nowIso } from '../../../../../shared/ids'
import type { MailMessageDTO } from '../../../../../shared/types'
import { requireMailboxPermission } from '../../../../utils/workspace-mail'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
import { loadMailMessage } from '../../../../utils/mail-data'
import { signalMailChanged } from '../../../../../workers/mail-events'

const schema = z.object({ content: z.string().trim().min(1).max(20_000) })

export default defineEventHandler(async (event): Promise<{ message: MailMessageDTO }> => {
  const id = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, id, 'send')
  if (access.channel.type !== 'thread') fail(404, 'not_found', 'Email conversation not found')
  const body = parseBody(schema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const messageId = newId()
  const created = nowIso()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, edited_at, deleted_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    ).bind(messageId, id, access.user.id, body.content, created),
    env.DB.prepare('UPDATE email_threads SET last_message_at = ?, updated_at = ? WHERE channel_id = ?').bind(created, created, id),
  ])
  waitUntil(signalMailChanged(env, access.mailboxId, id))
  const message = await loadMailMessage(env, messageId, access.user.id)
  if (!message) fail(404, 'not_found', 'Note not found')
  return { message }
})
