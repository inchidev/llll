import type { AuthorizationContext } from '../../shared/authorization'
import { encryptSecret } from '../../shared/encrypted-secret'
import { newId, nowIso } from '../../shared/ids'
import { NETWORK_PRESETS, projectNetwork, projectNetworkSchema, projectSecretCreateSchema, projectSecretUpdateSchema, secretPlaceholder, type ProjectSecret } from '../../shared/project-factory'
import type { L4Env } from '../../workers/env'
import { writeAudit } from './messages'
import { requireProject } from './project-service'
import { fail } from './cf'

/**
 * A Project's network and secrets for its Agents' boxes (ADR 0011). Whoever may manage the Project, as for
 * its repositories, sets them; anyone who reads the Project sees them, but never a secret's value. A value is
 * entered once, encrypted with scope `project-secret:<id>`, and only a box's egress layer ever decrypts it.
 */
const canManage = (auth: AuthorizationContext) => auth.principal.kind === 'human' && auth.credential.kind === 'session' && !auth.delegation
async function manageable(env: L4Env, auth: AuthorizationContext, projectId: string) {
  try { await requireProject(env, auth, projectId, true); return true } catch { return false }
}
async function writable(env: L4Env, auth: AuthorizationContext, projectId: string) {
  const project = await requireProject(env, auth, projectId, true)
  if (project.archivedAt) fail(409, 'project_archived', 'Restore the project before changing its network or secrets')
  return project
}

export async function getProjectNetwork(env: L4Env, auth: AuthorizationContext, projectId: string) {
  await requireProject(env, auth, projectId)
  const row = await env.DB.prepare('SELECT factory_json AS factoryJson FROM projects WHERE id=?').bind(projectId).first<{ factoryJson: string | null }>()
  return { network: projectNetwork(row?.factoryJson), presets: NETWORK_PRESETS, canManage: canManage(auth) && await manageable(env, auth, projectId) }
}
/** Replaces the network part of the Project's settings; its Git flow stays as stored. */
export async function saveProjectNetwork(env: L4Env, auth: AuthorizationContext, projectId: string, request: unknown) {
  await writable(env, auth, projectId)
  const network = projectNetworkSchema.parse(request)
  await env.DB.prepare("UPDATE projects SET factory_json=json_set(COALESCE(factory_json,'{}'),'$.network',json(?)),version=version+1,updated_at=? WHERE id=?")
    .bind(JSON.stringify(network), nowIso(), projectId).run()
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.network.update', targetType: 'project', targetId: projectId, authorization: auth })
  return getProjectNetwork(env, auth, projectId)
}

type SecretRow = { id: string; name: string; placeholder: string; hostsJson: string; createdAt: string; updatedAt: string; lastUsedAt: string | null }
const secretColumns = 'id,name,placeholder,hosts_json AS hostsJson,created_at AS createdAt,updated_at AS updatedAt,last_used_at AS lastUsedAt'
const visible = ({ hostsJson, ...row }: SecretRow): ProjectSecret => ({ ...row, hosts: JSON.parse(hostsJson) as string[] })

export async function listProjectSecrets(env: L4Env, auth: AuthorizationContext, projectId: string) {
  await requireProject(env, auth, projectId)
  const rows = await env.DB.prepare(`SELECT ${secretColumns} FROM project_secrets WHERE project_id=? ORDER BY name`).bind(projectId).all<SecretRow>()
  return { secrets: rows.results.map(visible), canManage: canManage(auth) && await manageable(env, auth, projectId) }
}
async function sealed(env: L4Env, id: string, value: string) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'secret_unavailable', 'Server credential encryption is unavailable')
  return encryptSecret(env.AUTH_SECRET, `project-secret:${id}`, value)
}
export async function createProjectSecret(env: L4Env, auth: AuthorizationContext, projectId: string, request: unknown) {
  await writable(env, auth, projectId)
  const input = projectSecretCreateSchema.parse(request), id = newId(), now = nowIso(), encrypted = await sealed(env, id, input.value)
  const inserted = await env.DB.prepare(`INSERT INTO project_secrets(id,project_id,name,placeholder,hosts_json,secret_ciphertext,secret_iv,secret_version,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING ${secretColumns}`)
    .bind(id, projectId, input.name, secretPlaceholder(input.name), JSON.stringify(input.hosts), encrypted.ciphertext, encrypted.iv, encrypted.version, auth.principal.id, now, now).first<SecretRow>()
  if (!inserted) fail(409, 'secret_exists', `This Project already has a secret named ${input.name}. Replace its value instead.`)
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.secret.create', targetType: 'project', targetId: projectId, authorization: auth, meta: { secretId: id, name: input.name } })
  return visible(inserted)
}
/** A new value, new bound hosts, or both. The old value is gone; the placeholder stays. */
export async function updateProjectSecret(env: L4Env, auth: AuthorizationContext, projectId: string, secretId: string, request: unknown) {
  await writable(env, auth, projectId)
  const input = projectSecretUpdateSchema.parse(request)
  const encrypted = input.value === undefined ? null : await sealed(env, secretId, input.value)
  const updated = await env.DB.prepare(`UPDATE project_secrets SET secret_ciphertext=COALESCE(?,secret_ciphertext),secret_iv=COALESCE(?,secret_iv),secret_version=COALESCE(?,secret_version),
    hosts_json=COALESCE(?,hosts_json),updated_at=? WHERE id=? AND project_id=? RETURNING ${secretColumns}`)
    .bind(encrypted?.ciphertext ?? null, encrypted?.iv ?? null, encrypted?.version ?? null, input.hosts ? JSON.stringify(input.hosts) : null, nowIso(), secretId, projectId).first<SecretRow>()
  if (!updated) fail(404, 'not_found', 'Project secret not found')
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.secret.update', targetType: 'project', targetId: projectId, authorization: auth,
    meta: { secretId, name: updated.name, value: input.value !== undefined, hosts: input.hosts !== undefined } })
  return visible(updated)
}
export async function deleteProjectSecret(env: L4Env, auth: AuthorizationContext, projectId: string, secretId: string) {
  await requireProject(env, auth, projectId, true)
  const removed = await env.DB.prepare('DELETE FROM project_secrets WHERE id=? AND project_id=? RETURNING name').bind(secretId, projectId).first<{ name: string }>()
  if (!removed) fail(404, 'not_found', 'Project secret not found')
  await writeAudit(env, { serverId: auth.serverId, actorId: auth.principal.id, action: 'project.secret.delete', targetType: 'project', targetId: projectId, authorization: auth, meta: { secretId, name: removed.name } })
}
