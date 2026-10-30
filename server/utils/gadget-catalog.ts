import { authorize, AuthorizationError, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { emptyGadgetSpec, type GadgetDetailDTO, type GadgetListDTO, type GadgetSpec, type GadgetSummaryDTO } from '../../shared/gadgets'
import { newId, nowIso } from '../../shared/ids'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { parseGadgetSpec, validateGadgetSpec } from './gadget-spec'
import { writeAudit } from './messages'

export type GadgetRow = GadgetSummaryDTO & { draftSpecJson: string }
/** Who manages or opens Apps: a signed-in Member, or an Agent within its Run's authority. */
export type GadgetActor = { user: { id: string }; serverId: string; roleId: string; authorization: AuthorizationContext }

export function canManageGadgets(actor: GadgetActor): boolean {
  return allowed(actor, ServerAction.manageGadgets) && allowed(actor, ServerAction.manageData)
}

function allowed(actor: GadgetActor, action: ServerAction): boolean {
  try { authorize(actor.authorization, action); return true }
  catch (error) { if (error instanceof AuthorizationError) return false; throw error }
}

export function canUseGadgets(actor: GadgetActor): boolean {
  return canManageGadgets(actor)
    || allowed(actor, ServerAction.useGadgets)
    || allowed(actor, ServerAction.manageGadgets)
}

function summary(row: GadgetRow): GadgetSummaryDTO {
  const { draftSpecJson: _draftSpecJson, ...value } = row
  return value
}

function selectGadgetSql(where = ''): string {
  return `SELECT id, name, description, position, draft_spec_json as draftSpecJson,
    draft_revision as draftRevision, published_version as publishedVersion,
    created_by as createdBy, created_at as createdAt, updated_at as updatedAt
    FROM gadgets ${where}`
}

export async function requireGadget(env: L4Env, id: string): Promise<GadgetRow> {
  const row = await env.DB.prepare(selectGadgetSql('WHERE id = ?')).bind(id).first<GadgetRow>()
  if (!row) fail(404, 'not_found', 'App not found')
  return row
}

export async function listGadgets(env: L4Env, actor: GadgetActor): Promise<GadgetListDTO> {
  const canManage = canManageGadgets(actor)
  if (!canManage && !canUseGadgets(actor)) fail(403, 'forbidden', 'Missing permission')
  if (canManage) {
    const result = await env.DB.prepare(`${selectGadgetSql()} ORDER BY position, created_at`).all<GadgetRow>()
    return { gadgets: (result.results ?? []).map(summary), canManage }
  }
  const result = await env.DB.prepare(
    `SELECT gadgets.id, versions.name, versions.description, gadgets.position,
      gadgets.draft_revision as draftRevision, gadgets.published_version as publishedVersion,
      gadgets.created_by as createdBy, gadgets.created_at as createdAt, versions.created_at as updatedAt
     FROM gadgets
     JOIN gadget_versions versions
       ON versions.gadget_id = gadgets.id AND versions.version = gadgets.published_version
     JOIN grants access ON access.gadget_version_id = versions.id
     WHERE access.role_id = ?
     ORDER BY gadgets.position, gadgets.created_at`,
  ).bind(actor.roleId).all<GadgetSummaryDTO>()
  return { gadgets: result.results ?? [], canManage }
}

export async function getGadgetDetail(env: L4Env, actor: GadgetActor, id: string): Promise<GadgetDetailDTO> {
  if (!canManageGadgets(actor)) fail(403, 'forbidden', 'Missing permission')
  const row = await requireGadget(env, id)
  const access = await env.DB.prepare('SELECT role_id as roleId FROM grants WHERE gadget_id = ? ORDER BY role_id').bind(id).all<{ roleId: string }>()
  let draftSpec: GadgetSpec
  try { draftSpec = parseGadgetSpec(JSON.parse(row.draftSpecJson)) }
  catch { fail(409, 'gadget_draft_invalid', 'The App draft is invalid') }
  await validateGadgetSpec(env, draftSpec, { authorization: actor.authorization })
  return { ...summary(row), draftSpec, roleIds: (access.results ?? []).map(item => item.roleId) }
}

async function validateRoleIds(env: L4Env, roleIds: string[]): Promise<string[]> {
  const ids = [...new Set(roleIds)]
  if (!ids.length) return ids
  const placeholders = ids.map(() => '?').join(', ')
  const found = await env.DB.prepare(`SELECT id FROM roles WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string }>()
  if ((found.results ?? []).length !== ids.length) fail(400, 'bad_request', 'A selected Role no longer exists')
  return ids
}

async function replaceRoleAccess(env: L4Env, gadgetId: string, roleIds: string[], actorId: string): Promise<void> {
  const statements = [env.DB.prepare('DELETE FROM grants WHERE gadget_id = ?').bind(gadgetId)]
  const now = nowIso()
  for (const roleId of roleIds) {
    statements.push(env.DB.prepare('INSERT INTO grants (id, role_id, permissions, gadget_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newId(), roleId, Permission.useGadgets, gadgetId, actorId, now))
  }
  await env.DB.batch(statements)
}

export async function createGadget(
  env: L4Env,
  actor: GadgetActor,
  input: { name: string; description?: string; spec?: GadgetSpec; roleIds?: string[] },
): Promise<GadgetDetailDTO> {
  if (!canManageGadgets(actor)) fail(403, 'forbidden', 'Managing Apps also requires Manage data')
  const spec = await validateGadgetSpec(env, input.spec ?? emptyGadgetSpec(), { authorization: actor.authorization })
  const roleIds = await validateRoleIds(env, input.roleIds ?? [])
  const duplicate = await env.DB.prepare('SELECT id FROM gadgets WHERE lower(name) = lower(?) LIMIT 1').bind(input.name).first()
  if (duplicate) fail(409, 'duplicate_name', 'An App with this name already exists')
  const position = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) + 1024 as value FROM gadgets').first<{ value: number }>()
  const id = newId()
  const now = nowIso()
  await env.DB.prepare(
    `INSERT INTO gadgets (id, name, description, draft_spec_json, draft_revision, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).bind(id, input.name, input.description ?? '', JSON.stringify(spec), position?.value ?? 1024, actor.user.id, now, now).run()
  await replaceRoleAccess(env, id, roleIds, actor.user.id)
  await writeAudit(env, { serverId: actor.serverId, actorId: actor.user.id, action: 'gadget.create', targetType: 'gadget', targetId: id, meta: { name: input.name }, authorization: actor.authorization })
  return { id, name: input.name, description: input.description ?? '', position: position?.value ?? 1024, draftRevision: 1, publishedVersion: null, createdBy: actor.user.id, createdAt: now, updatedAt: now, draftSpec: spec, roleIds }
}

export async function updateGadget(
  env: L4Env,
  actor: GadgetActor,
  id: string,
  input: { revision: number; name?: string; description?: string; spec?: GadgetSpec; roleIds?: string[] },
): Promise<GadgetDetailDTO> {
  if (!canManageGadgets(actor)) fail(403, 'forbidden', 'Managing Apps also requires Manage data')
  const current = await requireGadget(env, id)
  if (current.draftRevision !== input.revision) fail(409, 'stale_gadget', 'This App changed elsewhere. Reload and try again.')
  if (input.name && await env.DB.prepare('SELECT id FROM gadgets WHERE id <> ? AND lower(name) = lower(?) LIMIT 1').bind(id, input.name).first()) {
    fail(409, 'duplicate_name', 'An App with this name already exists')
  }
  const spec = await validateGadgetSpec(env, input.spec ?? JSON.parse(current.draftSpecJson), { authorization: actor.authorization })
  const roleIds = input.roleIds ? await validateRoleIds(env, input.roleIds) : null
  const updated = await env.DB.prepare(
    `UPDATE gadgets SET name = ?, description = ?, draft_spec_json = ?, draft_revision = draft_revision + 1, updated_at = ?
     WHERE id = ? AND draft_revision = ?`,
  ).bind(input.name ?? current.name, input.description ?? current.description, JSON.stringify(spec), nowIso(), id, input.revision).run()
  if (!updated.meta.changes) fail(409, 'stale_gadget', 'This App changed elsewhere. Reload and try again.')
  if (roleIds) await replaceRoleAccess(env, id, roleIds, actor.user.id)
  await writeAudit(env, { serverId: actor.serverId, actorId: actor.user.id, action: 'gadget.update', targetType: 'gadget', targetId: id, meta: { fields: Object.keys(input).filter(key => key !== 'revision') }, authorization: actor.authorization })
  return getGadgetDetail(env, actor, id)
}

export async function publishGadget(env: L4Env, actor: GadgetActor, id: string, revision: number): Promise<GadgetDetailDTO> {
  if (!canManageGadgets(actor)) fail(403, 'forbidden', 'Managing Apps also requires Manage data')
  const current = await requireGadget(env, id)
  if (current.draftRevision !== revision) fail(409, 'stale_gadget', 'This App changed elsewhere. Reload and try again.')
  const spec = await validateGadgetSpec(env, JSON.parse(current.draftSpecJson), { publish: true, authorization: actor.authorization })
  const version = (current.publishedVersion ?? 0) + 1
  const versionId = newId()
  const now = nowIso()
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO gadget_versions (id, gadget_id, version, name, description, spec_json, created_by, created_at)
       SELECT ?, id, ?, name, description, ?, ?, ? FROM gadgets WHERE id = ? AND draft_revision = ?`,
    ).bind(versionId, version, JSON.stringify(spec), actor.user.id, now, id, revision),
    env.DB.prepare(
      `INSERT INTO grants (id, role_id, permissions, gadget_version_id, created_by, created_at)
       SELECT lower(hex(randomblob(16))), access.role_id, access.permissions, versions.id, ?, ?
       FROM gadget_versions versions
       JOIN grants access ON access.gadget_id = versions.gadget_id
       WHERE versions.id = ? AND versions.gadget_id = ?`,
    ).bind(actor.user.id, now, versionId, id),
    env.DB.prepare('UPDATE gadgets SET published_version = ?, updated_at = ? WHERE id = ? AND draft_revision = ?')
      .bind(version, now, id, revision),
  ])
  if (!results[0]?.meta.changes) fail(409, 'stale_gadget', 'This App changed elsewhere. Reload and try again.')
  await writeAudit(env, { serverId: actor.serverId, actorId: actor.user.id, action: 'gadget.publish', targetType: 'gadget', targetId: id, meta: { version }, authorization: actor.authorization })
  return getGadgetDetail(env, actor, id)
}
