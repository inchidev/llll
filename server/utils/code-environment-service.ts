import { requireEnvironmentProject } from './project-service'
import { z } from 'zod'
import { codeEnvironmentSchema, type CodeEnvironment, type CodeEnvironmentInput, type RunEnvironment } from '../../shared/code-environments'
import { authorizeResource, resourceAllowed, type AuthorizationContext } from '../../shared/authorization'
import { hasPermission, Permission } from '../../shared/permissions'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { githubAgentClient, githubAgentConfigured } from './github-agent-client'
import { writeAudit } from './messages'
import { fail } from './cf'

const repository = z.object({ id: z.number().int().positive(), full_name: z.string(), archived: z.boolean(), fork: z.boolean(), source: z.object({ id: z.number().int().positive() }).optional() })
const commit = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/u), commit: z.object({ tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) }) }) })
export async function findCodeEnvironment(env: L4Env, id: string): Promise<CodeEnvironment | null> {
  const row = await env.DB.prepare('SELECT id,config_json as configJson,enabled,version FROM agent_environments WHERE id=?').bind(id)
    .first<{ id: string; configJson: string; enabled: number; version: number }>()
  if (!row) return null
  return { ...codeEnvironmentSchema.parse(JSON.parse(row.configJson)), id: row.id, enabled: Boolean(row.enabled), version: row.version }
}
export async function listCodeEnvironments(env: L4Env, auth: AuthorizationContext) {
  if (!auth.principal.isOwner && !hasPermission(auth.principal.permissions, Permission.useComputer) && !hasPermission(auth.principal.permissions, Permission.manageServer) && !hasPermission(auth.principal.permissions, Permission.manageRoles)) fail(403, 'code_denied', 'Computer access is not granted')
  const rows = await env.DB.prepare('SELECT id FROM agent_environments ORDER BY created_at').all<{ id: string }>()
  const visible = []
  for (const row of rows.results ?? []) {
    const item = await findCodeEnvironment(env, row.id)
    if (item && resourceAllowed(auth, 'repositories', String(item.sourceRepoId))) {
      try { await requireEnvironmentProject(env, auth, item.id); visible.push(item) } catch { /* Project scope can narrow repository visibility. */ }
    }
  }
  return visible
}
export async function saveCodeEnvironment(env: L4Env, auth: AuthorizationContext, request: CodeEnvironmentInput, id?: string) {
  if (auth.principal.kind !== 'human' || (!auth.principal.isOwner && !hasPermission(auth.principal.permissions, Permission.manageServer))) fail(403, 'code_denied', 'Server administration is required')
  const input = codeEnvironmentSchema.parse(request)
  authorizeResource(auth, 'repositories', String(input.sourceRepoId))
  const existing = id ? await findCodeEnvironment(env, id) : null
  if (id && !existing) fail(404, 'not_found', 'Environment not found')
  if (existing) {
    await requireEnvironmentProject(env, auth, existing.id)
    const linked = await env.DB.prepare('SELECT external_id AS externalId,slug,default_branch AS defaultBranch FROM project_repositories WHERE environment_id=?').bind(existing.id).first<{ externalId: string; slug: string; defaultBranch: string }>()
    if (linked && (linked.externalId !== String(input.sourceRepoId) || linked.slug.toLowerCase() !== input.sourceRepo.toLowerCase() || linked.defaultBranch !== input.baseBranch)) fail(409, 'project_repository_changed', 'Detach the project reference before changing repository identity or base branch')
  }
  if (existing) authorizeResource(auth, 'repositories', String(existing.sourceRepoId))
  const sourceClient = await githubAgentClient(env, { installationId: input.sourceInstallationId, repositoryId: input.sourceRepoId, access: 'read' })
  const workClient = await githubAgentClient(env, { installationId: input.workInstallationId, repositoryId: input.workRepoId, access: 'read' })
  const source = repository.parse(await sourceClient.json(`/repos/${input.sourceRepo}`))
  const work = repository.parse(await workClient.json(`/repos/${input.workRepo}`))
  if (source.id !== input.sourceRepoId || work.id !== input.workRepoId || source.full_name.toLowerCase() !== input.sourceRepo.toLowerCase()
    || work.full_name.toLowerCase() !== input.workRepo.toLowerCase() || source.archived || work.archived
    || (source.id !== work.id && (!work.fork || work.source?.id !== (source.source?.id ?? source.id)))) fail(400, 'code_repository', 'Choose the same active repository or an active fork from the same repository network')
  // Resolve a real base commit before accepting this configuration.
  commit.parse(await sourceClient.json(`/repos/${input.sourceRepo}/commits/${encodeURIComponent(input.baseBranch)}`))
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
    meta: { sourceRepo: input.sourceRepo, workRepo: input.workRepo }, authorization: auth })
  return (await findCodeEnvironment(env, environmentId))!
}
export async function disableCodeEnvironment(env: L4Env, auth: AuthorizationContext, id: string) {
  if (auth.principal.kind !== 'human' || (!auth.principal.isOwner && !hasPermission(auth.principal.permissions, Permission.manageServer))) fail(403, 'code_denied', 'Server administration is required')
  const item = await findCodeEnvironment(env, id)
  if (!item) fail(404, 'not_found', 'Environment not found')
  await requireEnvironmentProject(env, auth, item.id)
  authorizeResource(auth, 'repositories', String(item.sourceRepoId))
  await env.DB.prepare('UPDATE agent_environments SET enabled=0,version=version+1,updated_at=? WHERE id=?').bind(nowIso(), id).run()
}
export async function admitRunEnvironment(env: L4Env, auth: AuthorizationContext, id: string): Promise<RunEnvironment> {
  if (!githubAgentConfigured(env)) fail(409, 'github_unconfigured', 'Configure a dedicated GitHub App for code execution')
  const item = await findCodeEnvironment(env, id)
  if (!item?.enabled) fail(403, 'code_revoked', 'Repository environment is unavailable')
  await requireEnvironmentProject(env, auth, item.id)
  authorizeResource(auth, 'repositories', String(item.sourceRepoId))
  const client = await githubAgentClient(env, { installationId: item.sourceInstallationId, repositoryId: item.sourceRepoId, access: 'read' })
  const base = commit.parse(await client.json(`/repos/${item.sourceRepo}/commits/${encodeURIComponent(item.baseBranch)}`))
  return { ...item, baseSha: base.sha, baseTreeSha: base.commit.tree.sha }
}
export async function requireRunEnvironment(env: L4Env, auth: AuthorizationContext, snapshot: RunEnvironment) {
  const current = await findCodeEnvironment(env, snapshot.id)
  if (!current?.enabled || current.version !== snapshot.version) fail(403, 'code_revoked', 'Repository environment was changed or disabled')
  await requireEnvironmentProject(env, auth, snapshot.id)
  authorizeResource(auth, 'repositories', String(snapshot.sourceRepoId))
  return snapshot
}
