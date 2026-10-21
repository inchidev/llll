import { parseResourceAccess } from '../../shared/resource-access'
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
    `SELECT u.kind, r.id as roleId, r.name as roleName, r.permissions_bitmask as perms, r.resource_access_json as resourceAccessJson, s.owner_id as ownerId
     FROM users u JOIN roles r ON r.id = u.role_id JOIN server s ON s.id = ?
     WHERE u.id = ? AND u.status = 'active'`,
  ).bind(serverId, credential.subjectId).first<{
    resourceAccessJson: string; kind: 'human' | 'agent'; roleId: string; roleName: string; perms: number; ownerId: string
  }>()
  if (!row) return null
  const isOwner = row.ownerId === credential.subjectId
  const perms = isOwner ? ALL_PERMISSIONS : row.perms
  if (!hasPermission(perms, Permission.mcpConnect)) return null
  const delegatedBy = credential.createdBy === credential.subjectId ? null : credential.createdBy
  let delegation: AuthorizationContext['delegation']
  if (delegatedBy) {
    if (row.kind !== 'agent') return null
    const creator = await env.DB.prepare(`SELECT r.name as roleName,r.permissions_bitmask as permissions,r.resource_access_json as resourceAccessJson
      FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=? AND u.kind='human' AND u.status='active'`)
      .bind(delegatedBy).first<{ roleName: string; permissions: number; resourceAccessJson: string }>()
    const creatorOwner = delegatedBy === row.ownerId
    if (!creator || (!creatorOwner && (!hasPermission(creator.permissions, Permission.manageAgents) || !hasPermission(creator.permissions, Permission.mcpConnect)))) return null
    const profile = await env.DB.prepare("SELECT status FROM agents WHERE user_id=?").bind(credential.subjectId).first<{ status: string }>()
    if (profile && profile.status !== 'active') return null
    delegation = { by: delegatedBy, permissions: creatorOwner ? ALL_PERMISSIONS : creator.permissions,
      isOwner: creatorOwner, roleName: creator.roleName, resourceAccess: creatorOwner ? {} : parseResourceAccess(creator.resourceAccessJson) }
  }
  return {
    tokenId: credential.id, userId: credential.subjectId, serverId,
    roleId: row.roleId, roleName: row.roleName, perms, isOwner, scopes: credential.scopes, delegatedBy,
    authorization: {
      serverId,
      principal: { id: credential.subjectId, kind: row.kind, roleId: row.roleId, roleName: row.roleName, permissions: perms, isOwner, resourceAccess: parseResourceAccess(row.resourceAccessJson) },
      credential: { kind: 'mcp', id: credential.id, scopes: credential.scopes, ...(credential.clientId ? { clientId: credential.clientId } : {}) },
      ...(delegation ? { delegation } : {}),
    },
  }
}
