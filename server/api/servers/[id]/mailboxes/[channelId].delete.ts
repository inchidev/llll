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
  if (!mailbox) fail(404, 'not_found', 'Mailbox not found')
  await env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(channelId).run()
  await writeAudit(env, {
    serverId,
    actorId: actor.user.id,
    action: 'mailbox.delete',
    targetType: 'mailbox',
    targetId: channelId,
    meta: { address: mailbox.address },
  })
  setResponseStatus(event, 204)
  return null
})
