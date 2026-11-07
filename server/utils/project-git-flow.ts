import type { AuthorizationContext } from '../../shared/authorization'
import type { RunEnvironment } from '../../shared/code-environments'
import { nowIso } from '../../shared/ids'
import { DEFAULT_GIT_FLOW, GIT_MERGE_LABELS, GIT_METHOD_LABELS, projectGitFlow, projectGitFlowSchema, type ProjectGitFlow } from '../../shared/project-factory'
import { boxBranch } from '../../shared/software-factory'
import type { L4Env } from '../../workers/env'
import { writeAudit } from './messages'
import { requireProject } from './project-service'
import { fail } from './cf'

/**
 * A Project's Git flow for its Agents' boxes (ADR 0011), set on the Project page next to its network and
 * secrets, by whoever may manage the Project. A box follows the Git flow of the Project its repository is
 * attached to; a repository attached to no Project, or to an archived one, has the default flow.
 */
const canManage = (auth: AuthorizationContext) => auth.principal.kind === 'human' && auth.credential.kind === 'session' && !auth.delegation
async function manageable(env: L4Env, auth: AuthorizationContext, projectId: string) {
  try { await requireProject(env, auth, projectId, true); return true } catch { return false }
}

export async function getProjectGitFlow(env: L4Env, auth: AuthorizationContext, projectId: string) {
  await requireProject(env, auth, projectId)
  const row = await env.DB.prepare('SELECT factory_json AS factoryJson FROM projects WHERE id=?').bind(projectId).first<{ factoryJson: string | null }>()
  return { gitFlow: projectGitFlow(row?.factoryJson), merges: GIT_MERGE_LABELS, methods: GIT_METHOD_LABELS, canManage: canManage(auth) && await manageable(env, auth, projectId) }
}
/** Replaces the Git flow part of the Project's settings; its network stays as stored. It applies to the next push or merge. */
export async function saveProjectGitFlow(env: L4Env, auth: AuthorizationContext, projectId: string, request: unknown) {
  const project = await requireProject(env, auth, projectId, true)
  if (project.archivedAt) fail(409, 'project_archived', 'Restore the project before changing its Git flow')
  const gitFlow = projectGitFlowSchema.parse(request)
  await env.DB.prepare("UPDATE projects SET factory_json=json_set(COALESCE(factory_json,'{}'),'$.gitFlow',json(?)),version=version+1,updated_at=? WHERE id=?")
    .bind(JSON.stringify(gitFlow), nowIso(), projectId).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.git_flow.update', targetType: 'project', targetId: projectId, authorization: auth, meta: gitFlow })
  return getProjectGitFlow(env, auth, projectId)
}

/** The Project a repository configuration is attached to, and its Git flow. */
export async function repositoryGitFlow(env: L4Env, environmentId: string): Promise<{ projectId: string | null; gitFlow: ProjectGitFlow }> {
  const row = await env.DB.prepare(`SELECT p.id AS projectId,p.factory_json AS factoryJson FROM project_repositories pr JOIN projects p ON p.id=pr.project_id
    WHERE pr.environment_id=? AND p.archived_at IS NULL`).bind(environmentId).first<{ projectId: string; factoryJson: string | null }>()
  return row ? { projectId: row.projectId, gitFlow: projectGitFlow(row.factoryJson) } : { projectId: null, gitFlow: DEFAULT_GIT_FLOW }
}

/** Where a box's next push goes under a Git flow: its own branch, or for direct_push the base branch itself. */
export function publishTarget(gitFlow: ProjectGitFlow, boxId: string, environment: Pick<RunEnvironment, 'baseBranch'>) {
  return gitFlow.merge === 'direct_push' ? { ref: environment.baseBranch, direct: true as const } : { ref: boxBranch(boxId, gitFlow.branchPrefix) }
}
