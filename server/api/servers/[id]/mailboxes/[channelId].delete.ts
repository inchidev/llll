import { removeMailboxData, cleanMailFiles } from '../../../../utils/mail-cleanup'
import { Permission } from '../../../../../shared/permissions'
import { spaceAllowed } from '../../../../../shared/spaces'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { writeAudit } from '../../../../utils/messages'
import { removeManagedMailboxRoute } from '../../../../utils/server-infrastructure'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const channelId = getRouterParam(event, 'channelId')!
  const actor = await requireMember(event, serverId, Permission.manageServer)
  const { env } = cf(event)
  const mailbox = await env.DB.prepare(
    `SELECT lower(mb.local_part || '@' || d.domain) AS address, d.zone_id, c.space_id AS spaceId
     FROM email_mailboxes mb JOIN email_domains d ON d.id = mb.domain_id JOIN channels c ON c.id = mb.channel_id
     WHERE mb.channel_id = ?`,
  ).bind(channelId).first<{ address: string; zone_id: string | null; spaceId: string }>()
  if (mailbox && !spaceAllowed(actor.authorization, mailbox.spaceId)) fail(404, 'not_found', 'Mailbox not found')
  const pending = !mailbox && await env.DB.prepare('SELECT key FROM file_deletions WHERE scope_id = ? LIMIT 1').bind(channelId).first()
  if (!mailbox && !pending) fail(404, 'not_found', 'Mailbox not found')
  // A rule left behind is harmless: mail to an address without a mailbox is refused.
  if (mailbox?.zone_id) await removeManagedMailboxRoute(env, mailbox.zone_id, mailbox.address).catch(() => undefined)
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
