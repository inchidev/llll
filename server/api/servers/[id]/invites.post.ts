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
import { creationSpaceId } from '../../../../shared/spaces'
import { authorizeProjectInvite, PROJECT_INVITE_POLICY } from '../../../utils/project-policies'

const bodySchema = z.object({
  maxUses: z.number().int().min(0).max(1000).optional(),
  expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
  /** A Project invite: whoever joins from it can act in this Project at once. */
  projectId: z.string().min(8).optional(),
})

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId, Permission.invite)
  const body = parseBody(bodySchema, await readBody(event).catch(() => ({})))
  const { env } = cf(event)
  if (env.AUTH_MODE?.trim().toLowerCase() === 'access') {
    fail(400, 'managed_by_access', 'Add member emails to the Cloudflare Access application policy')
  }
  const db = getDb(env.DB)
  // An invite joins its Space and nothing else, so someone new sees only that department.
  // A Project invite joins the Project's Space, which assigning access there has just checked.
  const spaceId = body.projectId ? await authorizeProjectInvite(env, member.authorization, body.projectId) : creationSpaceId(member.authorization)
  if (!spaceId) fail(403, 'forbidden', 'Choose a Space first')
  const code = newInviteCode()
  const created = nowIso()
  const expiresAt = body.expiresInHours
    ? dayjs().add(body.expiresInHours, 'hour').toISOString()
    : null
  await db.insert(invites).values({
    code,
    spaceId,
    creatorId: member.user.id,
    maxUses: body.maxUses ?? 0,
    uses: 0,
    expiresAt,
    createdAt: created,
    projectId: body.projectId ?? null,
    policyId: body.projectId ? PROJECT_INVITE_POLICY : null,
  })
  await writeAudit(env, { serverId, actorId: member.user.id, action: 'invite.create', targetType: 'invite', targetId: code, meta: body.projectId ? { projectId: body.projectId } : undefined })
  return { invite: { code, url: `/invite/${code}`, maxUses: body.maxUses ?? 0, uses: 0, expiresAt } }
})
