import dayjs from 'dayjs'
import { z } from 'zod'
import { invites } from '../../../../drizzle/schema'
import { newInviteCode, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { parseBody } from '../../../utils/validate'
import { writeAudit } from '../../../utils/messages'

const bodySchema = z.object({
  maxUses: z.number().int().min(0).max(1000).optional(),
  expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
})

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId, Permission.invite)
  const body = parseBody(bodySchema, await readBody(event).catch(() => ({})))
  const { env } = cf(event)
  if (env.AUTH_MODE?.trim().toLowerCase() === 'access') {
    fail(400, 'managed_by_access', 'Add member emails to the Cloudflare Access application policy')
  }
  const db = getDb(env.DB)
  const code = newInviteCode()
  const created = nowIso()
  const expiresAt = body.expiresInHours
    ? dayjs().add(body.expiresInHours, 'hour').toISOString()
    : null
  await db.insert(invites).values({
    code,
    creatorId: member.user.id,
    maxUses: body.maxUses ?? 0,
    uses: 0,
    expiresAt,
    createdAt: created,
  })
  await writeAudit(env, { workspaceId, actorId: member.user.id, action: 'invite.create', targetType: 'invite', targetId: code })
  return { invite: { code, url: `/invite/${code}`, maxUses: body.maxUses ?? 0, uses: 0, expiresAt } }
})
