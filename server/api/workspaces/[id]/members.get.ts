import { eq } from 'drizzle-orm'
import { roles, users } from '../../../../drizzle/schema'
import { hasPermission, Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { toPublicUser } from '../../../utils/messages'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const actor = await requireMember(event, id)
  const { env } = cf(event)
  const db = getDb(env.DB)

  let presence: Array<{ userId: string; status: 'online' | 'idle' | 'offline' }> = []
  try {
    const stub = asRpc<{
      snapshot: () => Promise<Array<{ userId: string; status: 'online' | 'idle' | 'offline' }>>
    }>(env.WORKSPACE_DO.getByName(`workspace:${id}`))
    presence = await stub.snapshot()
  }
  catch {
    // Workspace presence DO may be cold in nuxt-only local dev
  }
  const statusMap = new Map(presence.map((p) => [p.userId, p.status]))
  const canViewRoleDetails = actor.isOwner
    || hasPermission(actor.perms, Permission.manageRoles)
    || hasPermission(actor.perms, Permission.manageChannels)
  const canViewAgents = actor.isOwner || hasPermission(actor.perms, Permission.manageWorkspace)

  const rows = await db.select({
    user: users,
    role: roles,
    nickname: users.nickname,
  }).from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.status, 'active'))

  return {
    members: rows.filter(r => canViewAgents || r.user.kind !== 'agent').map((r) => ({
      user: toPublicUser(r.user),
      role: {
        id: r.role.id,
        workspaceId: id,
        key: r.role.key,
        name: r.role.name,
        permissions: canViewRoleDetails || r.user.id === actor.user.id ? r.role.permissionsBitmask : 0,
        position: r.role.position,
        isSystem: r.role.isSystem,
      },
      nickname: r.nickname,
      status: statusMap.get(r.user.id) ?? 'offline',
    })),
  }
})
