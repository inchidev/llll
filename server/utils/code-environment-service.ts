import { gitConnectionProvider } from './git-connections'
import { requireEnvironmentProject } from './project-service'
import { z } from 'zod'
import { codeEnvironmentSchema, repositoryResourceId, type CodeEnvironment, type CodeEnvironmentInput, type RunEnvironment } from '../../shared/code-environments'
import { authorizeResource, resourceAllowed, type AuthorizationContext } from '../../shared/authorization'
import { hasPermission, Permission } from '../../shared/permissions'
import { anyProjectPermission, projectPermissionAllowed } from '../../shared/project-access'
import { authorize, ServerAction } from '../../shared/authorization'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { gitAgentConfigured, repositoryClient, requireGitConnection } from './git-provider'
import { writeAudit } from './messages'
import { fail } from './cf'

// GitHub names the root of a fork network `source`; Gitea names the direct `parent`.
const repository = z.object({ id: z.number().int().positive(), full_name: z.string(), archived: z.boolean(), fork: z.boolean(), source: z.object({ id: z.number().int().positive() }).optional(), parent: z.object({ id: z.number().int().positive() }).nullable().optional() })
const commit = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/u), commit: z.object({ tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) }) }) })
/** GitHub resolves a branch at /commits/{ref}; Gitea at /git/commits/{ref}. Both return the commit and its tree. */
export const commitPath = (provider: 'github' | 'gitea', repo: string, ref: string) => provider === 'gitea' ? `/repos/${repo}/git/commits/${encodeURIComponent(ref)}` : `/repos/${repo}/commits/${encodeURIComponent(ref)}`
export async function findCodeEnvironment(env: L4Env, id: string): Promise<CodeEnvironment | null> {
  const row = await env.DB.prepare('SELECT id,config_json as configJson,enabled,version FROM agent_environments WHERE id=?').bind(id)
    .first<{ id: string; configJson: string; enabled: number; version: number }>()
  if (!row) return null
  return { ...codeEnvironmentSchema.parse(JSON.parse(row.configJson)), id: row.id, enabled: Boolean(row.enabled), version: row.version }
}
export async function listCodeEnvironments(env: L4Env, auth: AuthorizationContext) {
  const global = auth.principal.isOwner || hasPermission(auth.principal.permissions, Permission.useComputer) || hasPermission(auth.principal.permissions, Permission.manageServer) || hasPermission(auth.principal.permissions, Permission.manageRoles)
  if (!global && !anyProjectPermission(auth, Permission.useComputer)) fail(403, 'code_denied', 'Computer access is not granted')
  const rows = await env.DB.prepare('SELECT id FROM agent_environments ORDER BY created_at').all<{ id: string }>()
  const visible = []
  for (const row of rows.results ?? []) {
    const item = await findCodeEnvironment(env, row.id)
    const link = item ? await env.DB.prepare('SELECT project_id AS id FROM project_repositories WHERE environment_id=?').bind(item.id).first<{ id: string }>() : null
    const scoped = item && link && projectPermissionAllowed(auth, link.id, Permission.useComputer, { kind: 'repositories', id: repositoryResourceId(item) })
    if (item && (scoped || (global && resourceAllowed(auth, 'repositories', repositoryResourceId(item))))) {
      try { await requireEnvironmentProject(env, auth, item.id); visible.push(item) } catch { /* Project scope can narrow repository visibility. */ }
    }
  }
  return visible
}
export async function saveCodeEnvironment(env: L4Env, auth: AuthorizationContext, request: CodeEnvironmentInput, id?: string) {
  if (auth.principal.kind !== 'human' || (!auth.principal.isOwner && !hasPermission(auth.principal.permissions, Permission.manageServer))) fail(403, 'code_denied', 'Server administration is required')
  // The provider follows the chosen connection, never the request.
  const provider = await gitConnectionProvider(env, request.gitConnectionId)
  const input = codeEnvironmentSchema.parse({ ...request, provider })
  authorizeResource(auth, 'repositories', repositoryResourceId(input))
  const existing = id ? await findCodeEnvironment(env, id) : null
  if (id && !existing) fail(404, 'not_found', 'Environment not found')
  if (existing) {
    await requireEnvironmentProject(env, auth, existing.id)
    const linked = await env.DB.prepare('SELECT external_id AS externalId,slug,default_branch AS defaultBranch FROM project_repositories WHERE environment_id=?').bind(existing.id).first<{ externalId: string; slug: string; defaultBranch: string }>()
    if (linked && (existing.provider !== input.provider || (input.provider === 'gitea' && existing.gitConnectionId !== input.gitConnectionId) || linked.externalId !== String(input.sourceRepoId) || linked.slug.toLowerCase() !== input.sourceRepo.toLowerCase() || linked.defaultBranch !== input.baseBranch)) fail(409, 'project_repository_changed', 'Detach the project reference before changing repository identity or base branch')
  }
  if (existing) authorizeResource(auth, 'repositories', repositoryResourceId(existing))
  const sourceClient = await repositoryClient(env, input, 'source', 'read')
  const workClient = await repositoryClient(env, input, 'work', 'read')
  const source = repository.parse(await sourceClient.json(`/repos/${input.sourceRepo}`))
  const work = repository.parse(await workClient.json(`/repos/${input.workRepo}`))
  if (source.id !== input.sourceRepoId || work.id !== input.workRepoId || source.full_name.toLowerCase() !== input.sourceRepo.toLowerCase()
    || work.full_name.toLowerCase() !== input.workRepo.toLowerCase() || source.archived || work.archived
    || (source.id !== work.id && (!work.fork || (provider === 'gitea' ? work.parent?.id !== source.id : work.source?.id !== (source.source?.id ?? source.id))))) fail(400, 'code_repository', 'Choose the same active repository or an active fork from the same repository network')
  // Resolve a real base commit before accepting this configuration.
  commit.parse(await sourceClient.json(commitPath(provider, input.sourceRepo, input.baseBranch)))
  const environmentId = existing?.id ?? newId()
  const now = nowIso()
  const config = JSON.stringify(input)
  if (existing) { const updated = await env.DB.prepare('UPDATE agent_environments SET config_json=?,enabled=1,version=version+1,updated_at=? WHERE id=? AND version=?')
    .bind(config, now, environmentId, existing.version).run()
    if (!updated.meta.changes) fail(409, 'code_environment_changed', 'Environment changed while it was being saved')
  }
  else await env.DB.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)')
    .bind(environmentId, config, auth.principal.id, now, now).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'agent.environment.configure', targetType: 'environment', targetId: environmentId,
    meta: { provider, sourceRepo: input.sourceRepo, workRepo: input.workRepo }, authorization: auth })
  return (await findCodeEnvironment(env, environmentId))!
}
export async function disableCodeEnvironment(env: L4Env, auth: AuthorizationContext, id: string) {
  if (auth.principal.kind !== 'human' || (!auth.principal.isOwner && !hasPermission(auth.principal.permissions, Permission.manageServer))) fail(403, 'code_denied', 'Server administration is required')
  const item = await findCodeEnvironment(env, id)
  if (!item) fail(404, 'not_found', 'Environment not found')
  await requireEnvironmentProject(env, auth, item.id)
  authorizeResource(auth, 'repositories', repositoryResourceId(item))
  await env.DB.prepare('UPDATE agent_environments SET enabled=0,version=version+1,updated_at=? WHERE id=?').bind(nowIso(), id).run()
}
export async function admitRunEnvironment(env: L4Env, auth: AuthorizationContext, id: string): Promise<RunEnvironment> {
  authorize(auth, ServerAction.useComputer)
  const item = await findCodeEnvironment(env, id)
  if (!item?.enabled) fail(403, 'code_revoked', 'Repository environment is unavailable')
  if (!await gitAgentConfigured(env, item.gitConnectionId)) fail(409, 'git_unconfigured', 'Connect GitHub or Gitea in Server settings')
  await requireEnvironmentProject(env, auth, item.id)
  authorizeResource(auth, 'repositories', repositoryResourceId(item))
  const client = await repositoryClient(env, item, 'source', 'read')
  const base = commit.parse(await client.json(commitPath(item.provider, item.sourceRepo, item.baseBranch)))
  return { ...item, baseSha: base.sha, baseTreeSha: base.commit.tree.sha }
}
export async function requireRunEnvironment(env: L4Env, auth: AuthorizationContext, snapshot: RunEnvironment) {
  authorize(auth, ServerAction.useComputer)
  const current = await findCodeEnvironment(env, snapshot.id)
  if (!current?.enabled || current.version !== snapshot.version) fail(403, 'code_revoked', 'Repository environment was changed or disabled')
  await requireGitConnection(env, current)
  await requireEnvironmentProject(env, auth, snapshot.id)
  authorizeResource(auth, 'repositories', repositoryResourceId(snapshot))
  return snapshot
}
