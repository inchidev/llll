import { authorize, WorkspaceAction, type AuthorizationContext } from '../../shared/authorization'
import { newId, nowIso, WORKSPACE_ID } from '../../shared/ids'
import { MCP_SCOPES, type CreatedMcpAccessTokenDTO, type McpAccessTokenDTO, type McpScope } from '../../shared/mcp'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import type { PublicUser } from '../../shared/types'
import type { L4Env } from '../../workers/env'

const TOKEN_PREFIX = 'dfmcp_'
const TOKEN_BYTES = 32

type TokenRow = Omit<McpAccessTokenDTO, 'scopes' | 'subject' | 'createdBy'> & {
  scopesJson: string
  subjectId: string
  subjectKind: 'human' | 'agent'
  subjectName: string
  subjectAvatarR2Key: string | null
  creatorId: string
  creatorKind: 'human' | 'agent'
  creatorName: string
  creatorAvatarR2Key: string | null
}

export type McpPrincipal = {
  tokenId: string
  userId: string
  workspaceId: string
  roleId: string
  roleName: string
  perms: number
  isOwner: boolean
  scopes: McpScope[]
  delegatedBy: string | null
  authorization: AuthorizationContext
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return bytesToHex(new Uint8Array(digest))
}

function parseScopes(value: string): McpScope[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((scope): scope is McpScope => MCP_SCOPES.includes(scope as McpScope))
  }
  catch {
    return []
  }
}

function publicUser(row: TokenRow, prefix: 'subject' | 'creator'): PublicUser {
  return {
    id: row[`${prefix}Id`],
    kind: row[`${prefix}Kind`],
    displayName: row[`${prefix}Name`],
    avatarR2Key: row[`${prefix}AvatarR2Key`],
  }
}

export async function listMcpAccessTokens(env: L4Env): Promise<McpAccessTokenDTO[]> {
  const result = await env.DB.prepare(
    `SELECT t.id, t.name, t.token_prefix as tokenPrefix, t.scopes_json as scopesJson,
     t.last_used_at as lastUsedAt, t.created_at as createdAt,
     COALESCE(t.subject_id, t.created_by) as subjectId,
     subject.kind as subjectKind, subject.display_name as subjectName, subject.avatar_r2_key as subjectAvatarR2Key,
     creator.id as creatorId, creator.kind as creatorKind, creator.display_name as creatorName, creator.avatar_r2_key as creatorAvatarR2Key
     FROM mcp_access_tokens t
     JOIN users subject ON subject.id = COALESCE(t.subject_id, t.created_by)
     JOIN users creator ON creator.id = t.created_by
     WHERE t.revoked_at IS NULL ORDER BY t.created_at DESC`,
  ).all<TokenRow>()
  return (result.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: parseScopes(row.scopesJson),
    subject: publicUser(row, 'subject'),
    createdBy: publicUser(row, 'creator'),
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  }))
}

export async function issueMcpAccessToken(
  env: L4Env,
  input: { createdBy: string; subjectId: string; name: string; scopes: McpScope[] },
): Promise<CreatedMcpAccessTokenDTO> {
  const subject = await env.DB.prepare(
    "SELECT id, kind, display_name as displayName, avatar_r2_key as avatarR2Key FROM users WHERE id = ? AND status = 'active'",
  ).bind(input.subjectId).first<PublicUser>()
  const creator = await env.DB.prepare(
    "SELECT id, kind, display_name as displayName, avatar_r2_key as avatarR2Key FROM users WHERE id = ? AND status = 'active'",
  ).bind(input.createdBy).first<PublicUser>()
  if (!subject || !creator) throw new Error('Token subject and creator must be active workspace members')
  const scopes = [...new Set(input.scopes)].filter(scope => MCP_SCOPES.includes(scope))
  if (!scopes.length) throw new Error('Choose at least one MCP scope')

  const random = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  const token = `${TOKEN_PREFIX}${bytesToHex(random)}`
  const tokenHash = await hashToken(token)
  const tokenPrefix = token.slice(0, 14)
  const createdAt = nowIso()
  const id = newId()
  await env.DB.prepare(
    `INSERT INTO mcp_access_tokens
     (id, name, token_hash, token_prefix, scopes_json, subject_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, input.name, tokenHash, tokenPrefix, JSON.stringify(scopes), input.subjectId, input.createdBy, createdAt, createdAt).run()
  return { id, name: input.name, token, tokenPrefix, scopes, subject, createdBy: creator, lastUsedAt: null, createdAt }
}

export async function revokeMcpAccessToken(env: L4Env, id: string): Promise<boolean> {
  const now = nowIso()
  const result = await env.DB.prepare(
    'UPDATE mcp_access_tokens SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL',
  ).bind(now, now, id).run()
  return (result.meta.changes ?? 0) > 0
}

export async function authenticateMcpRequest(
  env: L4Env,
  request: Request,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<McpPrincipal | null> {
  const match = /^Bearer\s+(dfmcp_[0-9a-f]{64})$/i.exec(request.headers.get('authorization') ?? '')
  const token = match?.[1]
  if (!token) return null
  const tokenHash = await hashToken(token)
  const row = await env.DB.prepare(
    `SELECT t.id as tokenId, COALESCE(t.subject_id, t.created_by) as userId,
     t.created_by as createdBy, t.scopes_json as scopesJson, u.kind as userKind,
     r.id as roleId, r.name as roleName, r.permissions_bitmask as perms,
     w.owner_id as ownerId
     FROM mcp_access_tokens t
     JOIN users u ON u.id = COALESCE(t.subject_id, t.created_by) AND u.status = 'active'
     JOIN roles r ON r.id = u.role_id
     JOIN workspace w ON w.id = ?
     WHERE t.token_hash = ? AND t.revoked_at IS NULL
     LIMIT 1`,
  ).bind(WORKSPACE_ID, tokenHash).first<{
    tokenId: string
    userId: string
    createdBy: string
    scopesJson: string
    userKind: 'human' | 'agent'
    roleId: string
    roleName: string
    perms: number
    ownerId: string
  }>()
  if (!row) return null

  const touch = env.DB.prepare('UPDATE mcp_access_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), row.tokenId).run()
  if (waitUntil) waitUntil(touch)
  else await touch

  const isOwner = row.ownerId === row.userId
  const perms = isOwner ? ALL_PERMISSIONS : row.perms
  const scopes = parseScopes(row.scopesJson)
  const delegatedBy = row.createdBy === row.userId ? null : row.createdBy
  const authorization: AuthorizationContext = {
    workspaceId: WORKSPACE_ID,
    principal: { id: row.userId, kind: row.userKind, roleId: row.roleId, roleName: row.roleName, permissions: perms, isOwner },
    credential: { kind: 'mcp', id: row.tokenId, scopes },
    ...(delegatedBy ? { delegation: { by: delegatedBy } } : {}),
  }
  return {
    tokenId: row.tokenId,
    userId: row.userId,
    workspaceId: WORKSPACE_ID,
    roleId: row.roleId,
    roleName: row.roleName,
    perms,
    isOwner,
    scopes,
    delegatedBy,
    authorization,
  }
}

export function requireMcpAccess(principal: McpPrincipal, scope: McpScope): void {
  const action = scope === 'tasks:read' ? WorkspaceAction.readTasks
    : scope === 'tasks:write' ? WorkspaceAction.writeTasks
      : scope === 'documents:read' ? WorkspaceAction.readDocuments
        : WorkspaceAction.writeDocuments
  authorize(principal.authorization, action)
}
