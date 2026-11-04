import { inArray } from 'drizzle-orm'
import { reachableSpaceIds } from '../../../../shared/spaces'
import { invites } from '../../../../drizzle/schema'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId, Permission.invite)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const rows = await db.select().from(invites).where(inArray(invites.spaceId, reachableSpaceIds(member.authorization)))
  return {
    invites: rows.map((r) => ({
      code: r.code,
      url: `/invite/${r.code}`,
      maxUses: r.maxUses,
      uses: r.uses,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    })),
  }
})
