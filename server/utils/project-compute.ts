import type { AuthorizationContext } from '../../shared/authorization'
import { nowIso } from '../../shared/ids'
import { L4_COMPUTE_SIZE_LABELS, projectCompute, projectComputeSchema } from '../../shared/l4-compute'
import type { L4Env } from '../../workers/env'
import { writeAudit } from './messages'
import { requireProject } from './project-service'
import { fail } from './cf'

/**
 * A Project's box size on L4 Compute (ADR 0009), set on the Project page next to its Git flow and network by
 * whoever may manage the Project. It applies to the next box asked of llll.gg; a box already running keeps its
 * size. Prices are llll.gg's: the Server names sizes and links to Pricing.
 */
const canManage = (auth: AuthorizationContext) => auth.principal.kind === 'human' && auth.credential.kind === 'session' && !auth.delegation
async function manageable(env: L4Env, auth: AuthorizationContext, projectId: string) {
  try { await requireProject(env, auth, projectId, true); return true } catch { return false }
}

export async function getProjectCompute(env: L4Env, auth: AuthorizationContext, projectId: string) {
  await requireProject(env, auth, projectId)
  const row = await env.DB.prepare('SELECT factory_json AS factoryJson FROM projects WHERE id=?').bind(projectId).first<{ factoryJson: string | null }>()
  return { compute: projectCompute(row?.factoryJson), sizes: L4_COMPUTE_SIZE_LABELS, canManage: canManage(auth) && await manageable(env, auth, projectId) }
}
export async function saveProjectCompute(env: L4Env, auth: AuthorizationContext, projectId: string, request: unknown) {
  const project = await requireProject(env, auth, projectId, true)
  if (project.archivedAt) fail(409, 'project_archived', 'Restore the project before changing its compute')
  const compute = projectComputeSchema.parse(request)
  await env.DB.prepare("UPDATE projects SET factory_json=json_set(COALESCE(factory_json,'{}'),'$.compute',json(?)),version=version+1,updated_at=? WHERE id=?")
    .bind(JSON.stringify(compute), nowIso(), projectId).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.compute.update', targetType: 'project', targetId: projectId, authorization: auth, meta: compute })
  return getProjectCompute(env, auth, projectId)
}
