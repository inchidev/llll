import { eq } from 'drizzle-orm'
import { agents, roles, users } from '../../../../drizzle/schema'
import { ALL_PERMISSIONS, hasPermission, Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { toPublicUser } from '../../../utils/messages'
import { loadProjectPolicies } from '../../../utils/project-policies'
import { canViewAgentMembers, projectPermissionAllowed } from '../../../../shared/project-access'
import { parseResourceAccess } from '../../../../shared/resource-access'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const actor = await requireMember(event, id)
  const { env } = cf(event)
  const db = getDb(env.DB)

  let presence: Array<{ userId: string; status: 'online' | 'idle' | 'offline' }> = []
  try {
    const stub = asRpc<{
      snapshot: () => Promise<Array<{ userId: string; status: 'online' | 'idle' | 'offline' }>>
    }>(env.SERVER_DO.getByName(`server:${id}`))
    presence = await stub.snapshot()
  }
  catch {
    // Server presence DO may be cold in nuxt-only local dev
  }
  const statusMap = new Map(presence.map((p) => [p.userId, p.status]))
  const canViewRoleDetails = actor.isOwner
    || hasPermission(actor.perms, Permission.manageRoles)
    || hasPermission(actor.perms, Permission.manageChannels)
  const canViewAgents = canViewAgentMembers(actor.authorization)

  const rows = await db.select({
    user: users,
    role: roles,
    nickname: users.nickname,
    agentStatus: agents.status,
  }).from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .leftJoin(agents, eq(agents.userId, users.id))
    .where(eq(users.status, 'active'))

  return {
    members: await Promise.all(rows.filter(r => canViewAgents || r.user.kind !== 'agent').map(async (r) => ({
      user: toPublicUser(r.user),
      projectPolicies: (await loadProjectPolicies(env, r.user.id, r.role.id)).filter(grant => canViewRoleDetails || r.user.id === actor.user.id || projectPermissionAllowed(actor.authorization, grant.projectId, Permission.readProjects)),
      ...(r.user.kind === 'agent' ? { agentStatus: r.agentStatus ?? 'paused' } : {}),
      role: {
        id: r.role.id,
        serverId: id,
        key: r.role.key,
        name: r.role.name,
        permissions: canViewRoleDetails || r.user.id === actor.user.id ? (r.role.key === 'owner' ? ALL_PERMISSIONS : r.role.permissionsBitmask) : 0,
        ...(canViewRoleDetails || r.user.id === actor.user.id ? { resourceAccess: parseResourceAccess(r.role.resourceAccessJson) } : {}),
        position: r.role.position,
        isSystem: r.role.isSystem,
      },
      nickname: r.nickname,
      status: statusMap.get(r.user.id) ?? 'offline',
    }))),
  }
})
