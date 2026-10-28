import { retryMailFileCleanup } from '../../utils/mail-cleanup'
import { getServerId } from '../../../shared/server-id'
import type { MailboxDTO } from '../../../shared/types'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'
import { hasPermission, Permission } from '../../../shared/permissions'

export default defineEventHandler(async (event): Promise<{ mailboxes: MailboxDTO[] }> => {
  const member = await requireMember(event, (await getServerId(cf(event).env.DB)))
  if (!member.isOwner && !hasPermission(member.perms, Permission.readMail)) return { mailboxes: [] }
  const { env, waitUntil } = cf(event)
  waitUntil(retryMailFileCleanup(env))
  const rows = await env.DB.prepare(
    `SELECT mb.channel_id as channelId, mb.display_name as displayName, mb.enabled,
       a.permission, lower(mb.local_part || '@' || d.domain) as address,
       (SELECT count(*) FROM email_threads t
        LEFT JOIN channel_reads r ON r.channel_id = t.channel_id AND r.user_id = a.user_id
        WHERE t.mailbox_channel_id = mb.channel_id AND t.status = 'inbox'
          AND (r.last_read_message_id IS NULL OR r.last_read_message_id < (
            SELECT max(em.message_id) FROM email_messages em WHERE em.thread_channel_id = t.channel_id AND em.direction = 'inbound'
          ))) as unreadCount
     FROM email_mailboxes mb
     JOIN email_domains d ON d.id = mb.domain_id
     JOIN email_mailbox_access a ON a.channel_id = mb.channel_id
     WHERE a.user_id = ? AND mb.enabled = 1
     ORDER BY mb.display_name, address`,
  ).bind(member.user.id).all<MailboxDTO>()
  return { mailboxes: rows.results || [] }
})
