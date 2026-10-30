import { retryMailFileCleanup } from '../../../utils/mail-cleanup'
import type { MailSettingsDTO, MailboxPermission } from '../../../../shared/types'
import { Permission } from '../../../../shared/permissions'
import { mailboxGrantPermissionSql } from '../../../../shared/mail'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { serverEmailAvailable } from '../../../../workers/mail-transport'
import { ensureServerMailFromEnv } from '../../../utils/server-mail'

export default defineEventHandler(async (event): Promise<{ mail: MailSettingsDTO }> => {
  const serverId = getRouterParam(event, 'id')!
  await requireMember(event, serverId, Permission.manageServer)
  const { env, waitUntil } = cf(event)
  waitUntil(retryMailFileCleanup(env))
  await ensureServerMailFromEnv(env)
  const domains = await env.DB.prepare(
    'SELECT id, domain, app_hostname as appHostname FROM email_domains ORDER BY created_at, domain',
  ).all<{ id: string; domain: string; appHostname: string }>()
  const mailboxes = await env.DB.prepare(
    `SELECT mb.channel_id as channelId, mb.domain_id as domainId, lower(mb.local_part || '@' || d.domain) as address,
       mb.display_name as displayName, mb.enabled,
       (SELECT count(*) FROM email_threads t WHERE t.mailbox_channel_id = mb.channel_id) as conversationCount
     FROM email_mailboxes mb JOIN email_domains d ON d.id = mb.domain_id
     ORDER BY mb.display_name, address`,
  ).all<{ channelId: string; domainId: string; address: string; displayName: string; enabled: number; conversationCount: number }>()
  const access = await env.DB.prepare(
    `SELECT mailbox_id AS channelId, member_id AS userId, ${mailboxGrantPermissionSql('g')} AS permission FROM grants g WHERE mailbox_id IS NOT NULL`,
  ).all<{ channelId: string; userId: string; permission: MailboxPermission }>()
  return {
    mail: {
      configured: Boolean(domains.results?.length),
      domains: domains.results || [],
      sendingBound: serverEmailAvailable(env),
      mailboxes: (mailboxes.results || []).map(mailbox => ({
        ...mailbox,
        enabled: Boolean(mailbox.enabled),
        permission: 'manage' as const,
        unreadCount: 0,
        access: (access.results || []).filter(row => row.channelId === mailbox.channelId).map(row => ({ userId: row.userId, permission: row.permission })),
      })),
    },
  }
})
