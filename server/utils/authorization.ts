import { getServerId } from '../../shared/server-id'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import type { AuthorizationContext, CredentialKind, WorkspaceAction } from '../../shared/authorization'
import type { McpScope } from '../../shared/mcp'
import type { L4Env } from '../../workers/env'

export async function loadAuthorizationContext(
  env: L4Env,
  input: {
    principalId: string
    credential: { kind: CredentialKind; id?: string; scopes?: McpScope[] }
    delegatedBy?: string
    delegatedActions?: WorkspaceAction[]
  },
): Promise<AuthorizationContext | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.kind, r.id as roleId, r.name as roleName,
     r.permissions_bitmask as permissions, w.owner_id as ownerId
     FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN workspace w ON w.id = ?
     WHERE u.id = ? AND u.status = 'active'`,
  ).bind((await getServerId(env.DB)), input.principalId).first<{
    id: string
    kind: 'human' | 'agent'
    roleId: string
    roleName: string
    permissions: number
    ownerId: string
  }>()
  if (!row) return null
  const isOwner = row.ownerId === row.id
  const delegated = input.delegatedBy
    ? await env.DB.prepare(
        `SELECT r.name as roleName, r.permissions_bitmask as permissions, w.owner_id as ownerId
         FROM users u
         JOIN roles r ON r.id = u.role_id
         JOIN workspace w ON w.id = ?
         WHERE u.id = ? AND u.kind = 'human' AND u.status = 'active'`,
      ).bind((await getServerId(env.DB)), input.delegatedBy).first<{
        roleName: string
        permissions: number
        ownerId: string
      }>()
    : null
  if (input.delegatedBy && !delegated) return null
  return {
    workspaceId: (await getServerId(env.DB)),
    principal: {
      id: row.id,
      kind: row.kind,
      roleId: row.roleId,
      roleName: row.roleName,
      permissions: isOwner ? ALL_PERMISSIONS : row.permissions,
      isOwner,
    },
    credential: input.credential,
    ...(input.delegatedBy && delegated
      ? {
          delegation: {
            by: input.delegatedBy,
            permissions: delegated.permissions,
            isOwner: delegated.ownerId === input.delegatedBy,
            roleName: delegated.roleName,
            ...(input.delegatedActions ? { actions: input.delegatedActions } : {}),
          },
        }
      : {}),
  }
}
