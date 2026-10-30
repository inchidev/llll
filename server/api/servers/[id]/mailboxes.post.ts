import { z } from 'zod'
import { channels, emailMailboxes } from '../../../../drizzle/schema'
import { normalizeMailLocalPart } from '../../../../shared/mail'
import { newId, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import type { MailboxPermission } from '../../../../shared/types'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { ensureServerMailFromEnv, replaceMailboxAccess } from '../../../utils/server-mail'
import { parseBody } from '../../../utils/validate'
import { writeAudit } from '../../../utils/messages'

const schema = z.object({
  domainId: z.string().trim().min(1).max(128),
  localPart: z.string().min(1).max(64),
  displayName: z.string().trim().min(1).max(80),
  access: z.array(z.object({ userId: z.string().min(1), permission: z.enum(['read', 'send', 'manage']) })).max(200).default([]),
})

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId, Permission.manageServer)
  const body = parseBody(schema, await readBody(event))
  let localPart: string
  try { localPart = normalizeMailLocalPart(body.localPart) }
  catch (error) { fail(400, 'bad_request', error instanceof Error ? error.message : 'Invalid mailbox') }
  const { env } = cf(event)
  await ensureServerMailFromEnv(env)
  const domain = await env.DB.prepare('SELECT id, domain FROM email_domains WHERE id = ?').bind(body.domainId).first<{ id: string; domain: string }>()
  if (!domain) fail(409, 'mail_unconfigured', 'Install L4 with a Cloudflare mail domain first')
  const existing = await env.DB.prepare('SELECT channel_id FROM email_mailboxes WHERE domain_id = ? AND local_part = ?').bind(domain.id, localPart!).first()
  if (existing) fail(409, 'conflict', 'That mailbox already exists')
  const channelId = newId()
  const created = nowIso()
  const db = getDb(env.DB)
  const address = `${localPart!}@${domain.domain}`
  const grants = new Map<string, MailboxPermission>(body.access.map(row => [row.userId, row.permission]))
  grants.set(actor.ownerId, 'manage')
  grants.set(actor.user.id, actor.isOwner ? 'manage' : (grants.get(actor.user.id) || 'manage'))
  try {
    await db.batch([
      db.insert(channels).values({
        id: channelId,
        name: address,
        topic: '',
        type: 'text',
        visibility: 'private',
        categoryId: null,
        position: 0,
        liveMeetingId: null,
        parentId: null,
        parentMessageId: null,
        createdAt: created,
        updatedAt: created,
      }),
      db.insert(emailMailboxes).values({ channelId, domainId: domain.id, localPart: localPart!, displayName: body.displayName, enabled: true, createdAt: created, updatedAt: created }),
    ])
    await replaceMailboxAccess(env, channelId, [...grants].map(([userId, permission]) => ({ userId, permission })), actor.user.id)
  }
  catch (error) {
    await env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(channelId).run().catch(() => undefined)
    throw error
  }
  await writeAudit(env, {
    serverId,
    actorId: actor.user.id,
    action: 'mailbox.create',
    targetType: 'mailbox',
    targetId: channelId,
    meta: { address },
  })
  return { channelId }
})
