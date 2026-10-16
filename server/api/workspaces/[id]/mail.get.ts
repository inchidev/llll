import type { MailSettingsDTO, MailboxPermission } from '../../../../shared/types'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { workspaceEmailAvailable } from '../../../../workers/mail-transport'
import { ensureWorkspaceMailFromEnv } from '../../../utils/workspace-mail'

export default defineEventHandler(async (event): Promise<{ mail: MailSettingsDTO }> => {
  const workspaceId = getRouterParam(event, 'id')!
  await requireMember(event, workspaceId, Permission.manageWorkspace)
  const { env } = cf(event)
  await ensureWorkspaceMailFromEnv(env)
  const domains = await env.DB.prepare(
    'SELECT id, domain, app_hostname as appHostname FROM email_domains ORDER BY created_at, domain',
  ).all<{ id: string; domain: string; appHostname: string }>()
  const mailboxes = await env.DB.prepare(
    `SELECT mb.channel_id as channelId, mb.domain_id as domainId, lower(mb.local_part || '@' || d.domain) as address,
       mb.display_name as displayName, mb.enabled
     FROM email_mailboxes mb JOIN email_domains d ON d.id = mb.domain_id
     ORDER BY mb.display_name, address`,
  ).all<{ channelId: string; domainId: string; address: string; displayName: string; enabled: number }>()
  const access = await env.DB.prepare(
    'SELECT channel_id as channelId, user_id as userId, permission FROM email_mailbox_access',
  ).all<{ channelId: string; userId: string; permission: MailboxPermission }>()
  return {
    mail: {
      configured: Boolean(domains.results?.length),
      domains: domains.results || [],
      sendingBound: workspaceEmailAvailable(env),
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
