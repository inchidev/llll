import { hasPermission, Permission } from '../../shared/permissions'
import { resourceAllowed, authorizeResource, type AuthorizationContext } from '../../shared/authorization'
import { codeEnvironmentSchema } from '../../shared/code-environments'
import { projectSchema, projectPatchSchema, projectRepositorySchema, type Project, type ProjectRepository } from '../../shared/projects'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { writeAudit } from './messages'
import { fail } from './cf'
const columns = 'id,name,description,archived_at AS archivedAt,version,created_at AS createdAt,updated_at AS updatedAt'
export function projectPermission(auth: AuthorizationContext, write = false) {
  if (!auth.principal.isOwner && !hasPermission(auth.principal.permissions, write ? Permission.manageProjects : Permission.readProjects)) fail(403, 'project_denied', 'Project permission is required')
  if (auth.delegation && !auth.delegation.isOwner && !hasPermission(auth.delegation.permissions ?? 0, write ? Permission.manageProjects : Permission.readProjects)) fail(403, 'project_denied', 'Project delegation is required')
  // Project administration is a human control-plane action, not a model tool.
  if (write && (auth.principal.kind !== 'human' || auth.credential.kind !== 'session' || auth.delegation)) fail(403, 'project_denied', 'Project administration requires a human session')
}
export async function requireProject(env: L4Env, auth: AuthorizationContext, id: string, write = false): Promise<Project> {
  projectPermission(auth, write); authorizeResource(auth, 'projects', id)
  const row = await env.DB.prepare(`SELECT ${columns} FROM projects WHERE id=?`).bind(id).first<Project>()
  if (!row) fail(404, 'not_found', 'Project not found')
  return row
}
export async function listProjects(env: L4Env, auth: AuthorizationContext) {
  projectPermission(auth)
  const rows = await env.DB.prepare(`SELECT ${columns} FROM projects ORDER BY created_at,id`).all<Project>()
  return rows.results.filter(p => resourceAllowed(auth, 'projects', p.id))
}
export async function createProject(env: L4Env, auth: AuthorizationContext, request: unknown) {
  projectPermission(auth, true); authorizeResource(auth, 'projects', '*')
  const input = projectSchema.parse(request), id = newId(), now = nowIso()
  await env.DB.prepare('INSERT INTO projects(id,name,description,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(id, input.name, input.description, auth.principal.id, now, now).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.create', targetType: 'project', targetId: id, authorization: auth })
  return requireProject(env, auth, id)
}
export async function updateProject(env: L4Env, auth: AuthorizationContext, id: string, request: unknown) {
  const current = await requireProject(env, auth, id, true), input = projectPatchSchema.parse(request)
  const updated = await env.DB.prepare('UPDATE projects SET name=?,description=?,archived_at=?,version=version+1,updated_at=? WHERE id=? AND version=? RETURNING id')
    .bind(input.name ?? current.name, input.description ?? current.description, input.archived === undefined ? current.archivedAt : input.archived ? nowIso() : null, nowIso(), id, input.version).first()
  if (!updated) fail(409, 'project_changed', 'Project changed; reload before saving')
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.update', targetType: 'project', targetId: id, authorization: auth })
  return requireProject(env, auth, id)
}
export async function listProjectRepositories(env: L4Env, auth: AuthorizationContext, projectId: string) {
  await requireProject(env, auth, projectId)
  return (await env.DB.prepare('SELECT id,project_id AS projectId,provider,host,external_id AS externalId,slug,default_branch AS defaultBranch,environment_id AS environmentId,created_at AS createdAt FROM project_repositories WHERE project_id=? ORDER BY created_at,id').bind(projectId).all<ProjectRepository>()).results
}
export async function addProjectRepository(env: L4Env, auth: AuthorizationContext, projectId: string, request: unknown) {
  const project = await requireProject(env, auth, projectId, true)
  if (project.archivedAt) fail(409, 'project_archived', 'Restore the project before configuring repositories')
  const input = projectRepositorySchema.parse(request), id = newId()
  if (input.environmentId) {
    const environment = await env.DB.prepare('SELECT config_json AS config FROM agent_environments WHERE id=? AND enabled=1').bind(input.environmentId).first<{ config: string }>()
    if (!environment) fail(404, 'not_found', 'Git execution configuration unavailable')
    const config = codeEnvironmentSchema.parse(JSON.parse(environment.config))
    authorizeResource(auth, 'repositories', String(config.sourceRepoId))
    if (input.provider !== 'github' || new URL(input.host).origin !== 'https://github.com' || input.externalId !== String(config.sourceRepoId) || input.slug.toLowerCase() !== config.sourceRepo.toLowerCase() || input.defaultBranch !== config.baseBranch) fail(400, 'repository_mismatch', 'Repository reference must match the Git execution configuration')
  }
  const inserted = await env.DB.prepare('INSERT INTO project_repositories(id,project_id,provider,host,external_id,slug,default_branch,environment_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id')
    .bind(id, projectId, input.provider, new URL(input.host).origin, input.externalId ?? input.slug, input.slug, input.defaultBranch, input.environmentId ?? null, auth.principal.id, nowIso()).first()
  if (!inserted) fail(409, 'repository_exists', 'Repository is already attached to this project')
  if (input.environmentId) await env.DB.prepare('UPDATE agent_environments SET version=version+1,updated_at=? WHERE id=?').bind(nowIso(), input.environmentId).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.repository.add', targetType: 'project', targetId: projectId, authorization: auth })
  return (await listProjectRepositories(env, auth, projectId)).find(r => r.id === id)!
}
export async function removeProjectRepository(env: L4Env, auth: AuthorizationContext, projectId: string, id: string) {
  await requireProject(env, auth, projectId, true)
  const row = await env.DB.prepare('SELECT environment_id AS environmentId FROM project_repositories WHERE id=? AND project_id=?').bind(id, projectId).first<{ environmentId: string | null }>()
  if (!row) fail(404, 'not_found', 'Project repository not found')
  if (row.environmentId) await env.DB.prepare('UPDATE agent_environments SET version=version+1,updated_at=? WHERE id=?').bind(nowIso(), row.environmentId).run()
  const removed = await env.DB.prepare('DELETE FROM project_repositories WHERE id=? AND project_id=? RETURNING id').bind(id, projectId).first()
  if (!removed) fail(404, 'not_found', 'Project repository not found')
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.repository.remove', targetType: 'project', targetId: projectId, authorization: auth })
}

/** Project-bound Git execution always checks current project access, including cached/archive calls. */
export async function requireEnvironmentProject(env: L4Env, auth: AuthorizationContext, environmentId: string) {
  const link = await env.DB.prepare('SELECT project_id AS projectId FROM project_repositories WHERE environment_id=?').bind(environmentId).first<{ projectId: string }>()
  if (link) {
    const project = await requireProject(env, auth, link.projectId)
    if (project.archivedAt) fail(403, 'project_archived', 'Project execution is unavailable while archived')
  }
}
