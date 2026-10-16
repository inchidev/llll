import { invites } from '../../../../drizzle/schema'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  await requireMember(event, workspaceId, Permission.invite)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const rows = await db.select().from(invites)
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
