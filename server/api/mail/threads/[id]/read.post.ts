import { z } from 'zod'
import { requireMailboxPermission } from '../../../../utils/workspace-mail'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'

const schema = z.object({ messageId: z.string().min(8).max(80) })

/** Marks a conversation read up to a message. Reading only ever moves forward. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const access = await requireMailboxPermission(event, id, 'read')
  if (access.channel.type !== 'thread') fail(404, 'not_found', 'Email conversation not found')
  const body = parseBody(schema, await readBody(event))
  const { env } = cf(event)
  await env.DB.prepare(
    `INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
     WHERE channel_reads.last_read_message_id IS NULL OR channel_reads.last_read_message_id < excluded.last_read_message_id`,
  ).bind(id, access.user.id, body.messageId, new Date().toISOString()).run()
  return { ok: true }
})
