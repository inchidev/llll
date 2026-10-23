import { removeMailboxData, cleanMailFiles } from '../../../../utils/mail-cleanup'
import { Permission } from '../../../../../shared/permissions'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { writeAudit } from '../../../../utils/messages'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const channelId = getRouterParam(event, 'channelId')!
  const actor = await requireMember(event, serverId, Permission.manageServer)
  const { env } = cf(event)
  const mailbox = await env.DB.prepare(
    `SELECT lower(mb.local_part || '@' || d.domain) AS address
     FROM email_mailboxes mb JOIN email_domains d ON d.id = mb.domain_id
     WHERE mb.channel_id = ?`,
  ).bind(channelId).first<{ address: string }>()
  const pending = !mailbox && await env.DB.prepare('SELECT key FROM mail_file_deletions WHERE mailbox_id = ? LIMIT 1').bind(channelId).first()
  if (!mailbox && !pending) fail(404, 'not_found', 'Mailbox not found')
  if (mailbox) await removeMailboxData(env, channelId)
  if (mailbox) await writeAudit(env, {
    serverId,
    actorId: actor.user.id,
    action: 'mailbox.delete',
    targetType: 'mailbox',
    targetId: channelId,
    meta: { address: mailbox.address },
  })
  try {
    while (await cleanMailFiles(env, channelId) === 100) { /* Drain this mailbox; interrupted work remains queued. */ }
  }
  catch { fail(503, 'mail_cleanup_pending', 'The mailbox was removed, but file cleanup is pending. Retry deletion or refresh Mail settings to continue cleanup.') }
  setResponseStatus(event, 204)
  return null
})
