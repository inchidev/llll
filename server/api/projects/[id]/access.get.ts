import { listProjectAssignments, listProjectPolicies } from '../../../utils/project-policies'
import { requireProject } from '../../../utils/project-service'
import { Permission, hasPermission } from '../../../../shared/permissions'
import { projectPermissionAllowed } from '../../../../shared/project-access'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB)), id = getRouterParam(event, 'id')!
  await requireProject(env, actor.authorization, id)
  const canManage = (actor.isOwner || hasPermission(actor.perms, Permission.manageRoles)) && projectPermissionAllowed(actor.authorization, id, Permission.manageProjects)
  return { assignments: await listProjectAssignments(env, id), policies: canManage ? await listProjectPolicies(env) : [], canManage }
})
