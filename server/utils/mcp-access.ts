import type { McpPrincipal } from './mcp-principal'
import { resolveMcpPrincipal } from './mcp-principal'
import { authenticateOAuthMcpRequest } from './mcp-oauth'
import { findAgentRun, runAuthorization } from './agent-run-service'
import { RUN_CREDENTIAL_SCOPES, runCredentialId, verifyRunMcpCredential } from './mcp-run-credential'
import { authorize, authorizeMcpCredential, AuthorizationError, ServerAction } from '../../shared/authorization'
import { newId, nowIso } from '../../shared/ids'
import { MCP_SCOPES, type CreatedMcpAccessTokenDTO, type McpAccessTokenDTO, type McpScope } from '../../shared/mcp'
import { hasPermission, Permission } from '../../shared/permissions'
import type { PublicUser } from '../../shared/types'
import type { L4Env } from '../../workers/env'

const TOKEN_PREFIX = 'dfmcp_'
const TOKEN_BYTES = 32
/**
 * A standing token this Server issued, or one L4 Cloud's agent door issued for a seeded Agent (`l4a.<Server UUID>.<secret>`,
 * ADR 0012): the Server holds only its SHA-256, recorded by the claim, and reads it like its own.
 */
const BEARER_TOKEN = /^Bearer\s+(dfmcp_[0-9a-f]{64}|l4a\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{16,200})$/i

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
     WHERE t.revoked_at IS NULL AND t.space_id IS NULL ORDER BY t.created_at DESC`,
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
  if (!subject || !creator) throw new Error('Token subject and creator must be active server members')
  if (!await resolveMcpPrincipal(env, { id: '', subjectId: input.subjectId, createdBy: input.createdBy, scopes: input.scopes })) {
    throw new AuthorizationError('The selected member’s role does not allow mcp.connect')
  }
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
  resource = `${env.PUBLIC_ORIGIN || new URL(request.url).origin}/mcp`,
): Promise<McpPrincipal | null> {
  const header = request.headers.get('authorization') ?? ''
  const bound = /^Bearer\s+(dfrun_[0-9a-f-]{36}_[0-9a-f]{64})$/i.exec(header)
  if (bound) return authenticateRunCredential(env, bound[1]!)
  const match = BEARER_TOKEN.exec(header)
  const token = match?.[1]
  if (!token) return authenticateOAuthMcpRequest(env, request, resource, waitUntil)
  const tokenHash = await hashToken(token)
  const row = await env.DB.prepare(
    'SELECT id as tokenId, subject_id as userId, created_by as createdBy, scopes_json as scopesJson FROM mcp_access_tokens WHERE token_hash = ? AND revoked_at IS NULL AND space_id IS NULL',
  ).bind(tokenHash).first<{ tokenId: string; userId: string; createdBy: string; scopesJson: string }>()
  if (!row) return null
  const principal = await resolveMcpPrincipal(env, {
    id: row.tokenId, subjectId: row.userId, createdBy: row.createdBy, scopes: parseScopes(row.scopesJson),
  })
  if (!principal) return null
  const touch = env.DB.prepare('UPDATE mcp_access_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), row.tokenId).run()
  if (waitUntil) waitUntil(touch)
  else await touch
  return principal
}

/**
 * An external Agent's Run credential acts as the Agent for one running Run, with the Run's own
 * authority: its Role, narrowed to the person who asked, their Agent access and the Run's mandate,
 * rechecked on every request as any Run is. It is refused once the Run closes or its reply window ends.
 */
async function authenticateRunCredential(env: L4Env, token: string): Promise<McpPrincipal | null> {
  const runId = await verifyRunMcpCredential(env, token)
  if (!runId) return null
  const run = await findAgentRun(env, runId)
  if (!run || run.status !== 'running' || run.deadline <= nowIso()) return null
  // Only an Agent that works on its own computer is woken with a credential; a Run on a box calls back through its gateway.
  if (!await env.DB.prepare('SELECT 1 AS found FROM agent_webhooks WHERE agent_id=?').bind(run.agentId).first()) return null
  let authorization
  try { authorization = await runAuthorization(env, run) } catch { return null }
  // As for any MCP client, the Agent's Role must allow connecting.
  if (!hasPermission(authorization.principal.permissions, Permission.mcpConnect)) return null
  authorization.credential = { kind: 'mcp', id: runCredentialId(run.id), scopes: RUN_CREDENTIAL_SCOPES }
  return {
    tokenId: runCredentialId(run.id), userId: run.agentId, serverId: authorization.serverId,
    roleId: authorization.principal.roleId, roleName: authorization.principal.roleName, perms: authorization.principal.permissions,
    isOwner: false, scopes: RUN_CREDENTIAL_SCOPES, delegatedBy: run.initiatedBy, authorization,
  }
}

export function requireMcpAccess(principal: McpPrincipal, scope: McpScope): void {
  if (scope.startsWith('messages:') || scope.startsWith('mail:')) {
    // Chat role overrides, DM permissions and Mailbox grants are checked by message-service and mail-service.
    authorizeMcpCredential(principal.authorization, scope)
    return
  }
  const action = scope === 'data:manage' ? ServerAction.manageData : scope === 'tasks:read' ? ServerAction.readTasks
    : scope === 'tasks:write' ? ServerAction.writeTasks
      : scope === 'documents:read' ? ServerAction.readDocuments
        : scope === 'documents:write' ? ServerAction.writeDocuments
          : scope === 'data:read' ? ServerAction.readRecords : ServerAction.writeRecords
  authorize(principal.authorization, action)
}
