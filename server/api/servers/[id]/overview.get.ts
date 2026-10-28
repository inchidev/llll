import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!, Permission.manageServer)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can view server-wide totals')
  const { env } = cf(event)
  const totals = await env.DB.prepare(`SELECT
    (SELECT count(*) FROM users WHERE status='active' AND kind='human') AS people,
    (SELECT count(*) FROM users WHERE status='active' AND kind='agent') AS agents,
    (SELECT count(*) FROM channels c WHERE c.type='text' AND c.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM email_mailboxes m WHERE m.channel_id=c.id) AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.discussion_channel_id=c.id)) AS channels,
    (SELECT count(*) FROM projects WHERE archived_at IS NULL) AS projects,
    (SELECT count(*) FROM tasks WHERE archived_at IS NULL) AS tasks,
    (SELECT count(*) FROM database_definitions) AS tables,
    (SELECT count(*) FROM documents) AS documents,
    (SELECT count(*) FROM canvases) AS canvases,
    (SELECT count(*) FROM email_mailboxes WHERE enabled=1) AS mailboxes`).first()
  return { totals }
})
