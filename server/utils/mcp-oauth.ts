import { APIError } from 'better-auth/api'
import type { L4Env } from '../../workers/env'
import { MCP_SCOPES, type McpConnectionDTO, type McpScope } from '../../shared/mcp'
import { ALL_PERMISSIONS, hasPermission, Permission } from '../../shared/permissions'
import { newId, nowIso } from '../../shared/ids'
import { getServerId } from '../../shared/server-id'
import { resolveMcpPrincipal } from './mcp-principal'

export async function hashMcpToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function mcpActor(env: L4Env, actorId: string) {
  const actor = await env.DB.prepare(
    `SELECT u.id, u.kind, r.permissions_bitmask as perms, s.owner_id as ownerId
     FROM users u JOIN roles r ON r.id = u.role_id JOIN server s ON s.id = ?
     WHERE u.id = ? AND u.status = 'active' AND u.kind = 'human'`,
  ).bind(await getServerId(env.DB), actorId).first<{ id: string; perms: number; ownerId: string }>()
  if (!actor) throw new APIError('FORBIDDEN', { message: 'An active human member must authorize MCP access' })
  const canManageAgents = actor.ownerId === actor.id || hasPermission(actor.perms, Permission.manageServer)
  return { ...actor, canManageAgents, canConnect: actor.ownerId === actor.id || hasPermission(actor.perms, Permission.mcpConnect) }
}

export async function mcpConsentSubjects(env: L4Env, actorId: string) {
  const actor = await mcpActor(env, actorId)
  if (!actor.canConnect) return []
  const rows = await env.DB.prepare(
    `SELECT u.id, u.kind, u.display_name as displayName, u.avatar_r2_key as avatarR2Key, r.permissions_bitmask as permissions
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'active' AND (u.id = ? OR (? = 1 AND u.kind = 'agent')) ORDER BY u.display_name`,
  ).bind(actorId, actor.canManageAgents ? 1 : 0).all<{
    id: string; kind: 'human' | 'agent'; displayName: string; avatarR2Key: string | null; permissions: number
  }>()
  return (rows.results ?? []).filter(row => row.id === actor.ownerId || hasPermission(row.permissions, Permission.mcpConnect)).map(row => ({
    ...row,
    scopes: MCP_SCOPES.filter(scope => hasPermission(row.id === actor.ownerId ? ALL_PERMISSIONS : row.permissions,
      scope.startsWith('tasks:') ? Permission.manageTasks : Permission.manageDatabases)),
  }))
}

type ConnectionRow = { id: string; subjectId: string; createdBy: string; clientId: string; resource: string; scopesJson: string }

export async function requireMcpConnection(env: L4Env, id: string, actorId: string, resource: string) {
  const row = await env.DB.prepare(
    `SELECT x.id, x.subject_id as subjectId, x.created_by as createdBy, x.client_id as clientId, x.resource, x.scopes_json as scopesJson
     FROM mcp_oauth_connections x
     JOIN users subject ON subject.id = x.subject_id AND subject.status = 'active'
     JOIN roles subject_role ON subject_role.id = subject.role_id
     JOIN users creator ON creator.id = x.created_by AND creator.status = 'active' AND creator.kind = 'human'
     JOIN roles creator_role ON creator_role.id = creator.role_id
     JOIN server s ON s.id = ?
     WHERE x.id = ? AND x.created_by = ? AND x.resource = ? AND x.revoked_at IS NULL
     AND (subject.id = creator.id OR (subject.kind = 'agent' AND
       (s.owner_id = creator.id OR (creator_role.permissions_bitmask & ?) = ?)))
     AND (subject.id = s.owner_id OR (subject_role.permissions_bitmask & ?) = ?)
     AND (creator.id = s.owner_id OR (creator_role.permissions_bitmask & ?) = ?)`,
  ).bind(await getServerId(env.DB), id, actorId, resource, Permission.manageServer, Permission.manageServer,
    Permission.mcpConnect, Permission.mcpConnect, Permission.mcpConnect, Permission.mcpConnect).first<ConnectionRow>()
  if (!row) {
    throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'MCP connection was revoked or its member is no longer available' })
  }
  const scopes = JSON.parse(row.scopesJson) as McpScope[]
  return { ...row, scopes }
}

export async function createMcpConnection(env: L4Env, input: {
  createdBy: string; subjectId: string; clientId: string; resource: string; scopes: McpScope[]
}) {
  const subject = (await mcpConsentSubjects(env, input.createdBy)).find(item => item.id === input.subjectId)
  if (!subject || !input.scopes.length || input.scopes.some(scope => !subject.scopes.includes(scope))) {
    throw new APIError('FORBIDDEN', { message: 'Choose a member with mcp.connect and permissions within their current role' })
  }
  const id = newId()
  await env.DB.prepare(
    'INSERT INTO mcp_oauth_connections (id, client_id, subject_id, created_by, resource, scopes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, input.clientId, input.subjectId, input.createdBy, input.resource, JSON.stringify(input.scopes), nowIso()).run()
  return id
}

/** Application revocation also gates opaque refresh issuance, before rotation. */
export async function requireMcpRefreshGrant(env: L4Env, token: string, resource: string) {
  if (!token.startsWith('l4_rt_') || token.length > 512) return
  const row = await env.DB.prepare(
    `SELECT t.reference_id as connectionId, t.user_id as userId, t.client_id as clientId,
     s.id as sessionId FROM auth_oauth_refresh_token t LEFT JOIN auth_sessions s ON s.id = t.session_id AND s.expires_at > ?
     WHERE t.token = ?`,
  ).bind(Date.now(), await hashMcpToken(token.slice('l4_rt_'.length))).first<{
    connectionId: string; userId: string; clientId: string; sessionId: string | null
  }>()
  if (!row) return // Let the provider apply its normal invalid-client/grant errors and replay handling.
  const connection = await requireMcpConnection(env, row.connectionId, row.userId, resource)
  if (!row.sessionId || connection.clientId !== row.clientId) {
    throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'The MCP authorization session is no longer available' })
  }
}

export async function authenticateOAuthMcpRequest(env: L4Env, request: Request, resource: string, schedule?: (promise: Promise<unknown>) => void) {
  const raw = /^Bearer\s+l4_at_([a-zA-Z0-9]+)$/u.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!raw || raw.length > 256) return null
  const row = await env.DB.prepare(
    `SELECT t.id, t.reference_id as connectionId, t.user_id as createdBy, t.client_id as clientId,
     t.scopes as scopesJson, t.resources as resourcesJson, t.confirmation
     FROM auth_oauth_access_token t
     JOIN auth_oauth_client c ON c.client_id = t.client_id AND COALESCE(c.disabled, 0) = 0
     JOIN auth_sessions s ON s.id = t.session_id AND s.expires_at > ?
     WHERE t.token = ? AND t.expires_at > ? AND t.revoked IS NULL`,
  ).bind(Date.now(), await hashMcpToken(raw), Date.now()).first<{
    id: string; connectionId: string; createdBy: string; clientId: string; scopesJson: string; resourcesJson: string; confirmation: string | null
  }>()
  if (!row || row.confirmation) return null // Bearer cannot use sender-constrained credentials.
  const resources: unknown = JSON.parse(row.resourcesJson || 'null')
  if (!Array.isArray(resources) || resources.length !== 1 || resources[0] !== resource) return null
  let connection
  try { connection = await requireMcpConnection(env, row.connectionId, row.createdBy, resource) }
  catch (error) { if (error instanceof APIError) return null; throw error }
  if (connection.clientId !== row.clientId) return null
  const tokenScopes = JSON.parse(row.scopesJson) as string[]
  const scopes = connection.scopes.filter(scope => tokenScopes.includes(scope))
  const principal = await resolveMcpPrincipal(env, { id: connection.id, subjectId: connection.subjectId, createdBy: row.createdBy, scopes, clientId: row.clientId })
  if (!principal) return null
  const touch = env.DB.prepare('UPDATE mcp_oauth_connections SET last_used_at = ? WHERE id = ?').bind(nowIso(), connection.id).run()
  if (schedule) schedule(touch)
  else await touch
  return principal
}

export async function listMcpConnections(env: L4Env, actorId: string): Promise<McpConnectionDTO[]> {
  // Losing connection permission must not prevent inspecting or revoking access.
  const actor = await mcpActor(env, actorId)
  const rows = await env.DB.prepare(
    `SELECT x.id, x.client_id as clientId, c.name as clientName, x.scopes_json as scopesJson,
     x.created_at as createdAt, x.last_used_at as lastUsedAt, x.created_by as createdBy,
     u.id as subjectId, u.kind as subjectKind, u.display_name as subjectName, u.avatar_r2_key as subjectAvatar
     FROM mcp_oauth_connections x JOIN auth_oauth_client c ON c.client_id = x.client_id
     JOIN users u ON u.id = x.subject_id WHERE x.revoked_at IS NULL ORDER BY x.created_at DESC`,
  ).all<{
    id: string; clientId: string; clientName: string | null; scopesJson: string; createdAt: string; lastUsedAt: string | null; createdBy: string;
    subjectId: string; subjectKind: 'human' | 'agent'; subjectName: string; subjectAvatar: string | null
  }>()
  return (rows.results ?? []).filter(row => row.createdBy === actorId || (row.subjectKind === 'agent' && actor.canManageAgents))
    .map(row => ({
      id: row.id, clientId: row.clientId, clientName: row.clientName || 'MCP client', createdBy: row.createdBy,
      scopes: JSON.parse(row.scopesJson), createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
      subject: { id: row.subjectId, kind: row.subjectKind, displayName: row.subjectName, avatarR2Key: row.subjectAvatar },
    }))
}

export async function revokeMcpConnection(env: L4Env, id: string, actorId: string): Promise<boolean> {
  if (!(await listMcpConnections(env, actorId)).some(connection => connection.id === id)) return false
  // The connection is the revocation fence for both existing tokens and concurrent issuance.
  await env.DB.prepare('UPDATE mcp_oauth_connections SET revoked_at = ? WHERE id = ?').bind(nowIso(), id).run()
  await env.DB.prepare('UPDATE auth_oauth_access_token SET revoked = ? WHERE reference_id = ?').bind(Date.now(), id).run()
  await env.DB.prepare('UPDATE auth_oauth_refresh_token SET revoked = ? WHERE reference_id = ?').bind(Date.now(), id).run()
  return true
}
