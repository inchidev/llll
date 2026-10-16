import { z } from 'zod'
import { Permission } from '../../../../../shared/permissions'
import type { MailboxPermission } from '../../../../../shared/types'
import { nowIso } from '../../../../../shared/ids'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { replaceMailboxAccess } from '../../../../utils/workspace-mail'
import { parseBody } from '../../../../utils/validate'
import { writeAudit } from '../../../../utils/messages'

const schema = z.object({
  displayName: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  access: z.array(z.object({ userId: z.string().min(1), permission: z.enum(['read', 'send', 'manage']) })).max(200),
})

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const channelId = getRouterParam(event, 'channelId')!
  const actor = await requireMember(event, workspaceId, Permission.manageWorkspace)
  const body = parseBody(schema, await readBody(event))
  const { env } = cf(event)
  const mailbox = await env.DB.prepare('SELECT channel_id FROM email_mailboxes WHERE channel_id = ?').bind(channelId).first()
  if (!mailbox) fail(404, 'not_found', 'Mailbox not found')
  const grants = new Map<string, MailboxPermission>(body.access.map(row => [row.userId, row.permission]))
  grants.set(actor.ownerId, 'manage')
  grants.set(actor.user.id, actor.isOwner ? 'manage' : (grants.get(actor.user.id) || 'manage'))
  await env.DB.prepare('UPDATE email_mailboxes SET display_name = ?, enabled = ?, updated_at = ? WHERE channel_id = ?')
    .bind(body.displayName, body.enabled ? 1 : 0, nowIso(), channelId).run()
  await replaceMailboxAccess(env, channelId, [...grants].map(([userId, permission]) => ({ userId, permission })))
  await writeAudit(env, {
    workspaceId,
    actorId: actor.user.id,
    action: 'mailbox.update',
    targetType: 'mailbox',
    targetId: channelId,
    meta: { enabled: body.enabled, accessCount: grants.size },
  })
  return { ok: true }
})
