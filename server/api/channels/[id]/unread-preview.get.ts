import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { hydrateMessages } from '../../../utils/messages'
import { getDb } from '../../../utils/db'
import { messages } from '../../../../drizzle/schema'
import { inArray } from 'drizzle-orm'

/** Previewing the Inbox never advances a read cursor. Access is checked on every request. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, id)
  if (access.mailPermission) fail(400, 'mail_read', 'Read mail from the mailbox')
  const { env } = cf(event)
  const ids = await env.DB.prepare(`SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id
    LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = ?1
    LEFT JOIN channel_attention a ON a.channel_id = c.id AND a.user_id = ?1
    WHERE (c.id = ?2 OR (c.parent_id = ?2 AND c.type = 'thread' AND a.following = 1))
      AND m.deleted_at IS NULL AND m.id > COALESCE(r.last_read_message_id, '')
    ORDER BY m.id DESC LIMIT 5`).bind(access.user.id, id).all<{ id: string }>()
  if (!ids.results.length) return { messages: [] }
  const rows = await getDb(env.DB).select().from(messages).where(inArray(messages.id, ids.results.map(row => row.id)))
  rows.sort((a, b) => a.id.localeCompare(b.id))
  return { messages: await hydrateMessages(env, rows, access.user.id) }
})
