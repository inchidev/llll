import { parseResourceAccess } from '../../shared/resource-access'
import { getServerId } from '../../shared/server-id'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import type { AuthorizationContext, CredentialKind, ServerAction } from '../../shared/authorization'
import type { McpScope } from '../../shared/mcp'
import type { L4Env } from '../../workers/env'
import { loadProjectPolicies } from './project-policies'
import { loadAgentAccess } from './agent-access'

export async function loadAuthorizationContext(
  env: L4Env,
  input: {
    principalId: string
    credential: { kind: CredentialKind; id?: string; scopes?: McpScope[] }
    delegatedBy?: string
    delegatedActions?: ServerAction[]
  },
): Promise<AuthorizationContext | null> {
  const serverId = await getServerId(env.DB)
  // The principal and the delegating person are independent reads; their policies come next, together.
  const [row, delegated] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.kind, r.id as roleId, r.name as roleName,
       r.permissions_bitmask as permissions, r.resource_access_json as resourceAccessJson, w.owner_id as ownerId
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN server w ON w.id = ?
       WHERE u.id = ? AND u.status = 'active'`,
    ).bind(serverId, input.principalId).first<{
      id: string
      kind: 'human' | 'agent'
      roleId: string
      roleName: string
      permissions: number
      resourceAccessJson: string
      ownerId: string
    }>(),
    input.delegatedBy
      ? env.DB.prepare(
          `SELECT r.id as roleId, r.name as roleName, r.permissions_bitmask as permissions, r.resource_access_json as resourceAccessJson, w.owner_id as ownerId
           FROM users u
           JOIN roles r ON r.id = u.role_id
           JOIN server w ON w.id = ?
           WHERE u.id = ? AND u.kind = 'human' AND u.status = 'active'`,
        ).bind(serverId, input.delegatedBy).first<{
          roleId: string
          roleName: string
          permissions: number
          resourceAccessJson: string
          ownerId: string
        }>()
      : null,
  ])
  if (!row) return null
  const isOwner = row.ownerId === row.id
  if (input.delegatedBy && !delegated) return null
  const delegatedOwner = Boolean(delegated && delegated.ownerId === input.delegatedBy)
  // Agent access widens what this person may do through this Agent only. The Owner needs none.
  const [agentAccess, principalPolicies, delegatedPolicies] = await Promise.all([
    delegated && row.kind === 'agent' && !delegatedOwner ? loadAgentAccess(env, row.id, input.delegatedBy!, delegated.roleId) : undefined,
    loadProjectPolicies(env, row.id, row.roleId),
    input.delegatedBy && delegated ? loadProjectPolicies(env, input.delegatedBy, delegated.roleId) : [],
  ])
  return {
    serverId,
    principal: {
      id: row.id,
      kind: row.kind,
      roleId: row.roleId,
      roleName: row.roleName,
      permissions: isOwner ? ALL_PERMISSIONS : row.permissions,
      isOwner,
      resourceAccess: parseResourceAccess(row.resourceAccessJson),
      projectPolicies: principalPolicies,
    },
    credential: input.credential,
    ...(input.delegatedBy && delegated
      ? {
          delegation: {
            by: input.delegatedBy,
            permissions: delegated.permissions | (agentAccess?.permissions ?? 0),
            resourceAccess: parseResourceAccess(delegated.resourceAccessJson),
            isOwner: delegatedOwner,
            roleName: delegated.roleName,
            projectPolicies: [...delegatedPolicies, ...agentAccess?.projectPolicies ?? []],
            ...(agentAccess ? { agentAccess } : {}),
            ...(input.delegatedActions ? { actions: input.delegatedActions } : {}),
          },
        }
      : {}),
  }
}
