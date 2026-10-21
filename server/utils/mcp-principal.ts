import type { L4Env } from '../../workers/env'
import type { AuthorizationContext } from '../../shared/authorization'
import type { McpScope } from '../../shared/mcp'
import { ALL_PERMISSIONS, hasPermission, Permission } from '../../shared/permissions'
import { getServerId } from '../../shared/server-id'

export type McpPrincipal = {
  tokenId: string
  userId: string
  serverId: string
  roleId: string
  roleName: string
  perms: number
  isOwner: boolean
  scopes: McpScope[]
  delegatedBy: string | null
  authorization: AuthorizationContext
}

export async function resolveMcpPrincipal(
  env: L4Env,
  credential: { id: string; subjectId: string; createdBy: string; scopes: McpScope[]; clientId?: string },
): Promise<McpPrincipal | null> {
  const serverId = await getServerId(env.DB)
  const row = await env.DB.prepare(
    `SELECT u.kind, r.id as roleId, r.name as roleName, r.permissions_bitmask as perms, s.owner_id as ownerId
     FROM users u JOIN roles r ON r.id = u.role_id JOIN server s ON s.id = ?
     WHERE u.id = ? AND u.status = 'active'`,
  ).bind(serverId, credential.subjectId).first<{
    kind: 'human' | 'agent'; roleId: string; roleName: string; perms: number; ownerId: string
  }>()
  if (!row) return null
  const isOwner = row.ownerId === credential.subjectId
  const perms = isOwner ? ALL_PERMISSIONS : row.perms
  if (!hasPermission(perms, Permission.mcpConnect)) return null
  const delegatedBy = credential.createdBy === credential.subjectId ? null : credential.createdBy
  return {
    tokenId: credential.id, userId: credential.subjectId, serverId,
    roleId: row.roleId, roleName: row.roleName, perms, isOwner, scopes: credential.scopes, delegatedBy,
    authorization: {
      serverId,
      principal: { id: credential.subjectId, kind: row.kind, roleId: row.roleId, roleName: row.roleName, permissions: perms, isOwner },
      credential: { kind: 'mcp', id: credential.id, scopes: credential.scopes, ...(credential.clientId ? { clientId: credential.clientId } : {}) },
      ...(delegatedBy ? { delegation: { by: delegatedBy } } : {}),
    },
  }
}
