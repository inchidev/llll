import type { McpScope } from './mcp'
import { hasPermission, Permission, type PermissionFlag } from './permissions'
import type { UserKind } from './types'

export const WorkspaceAction = {
  readTasks: 'tasks:read',
  writeTasks: 'tasks:write',
  readDocuments: 'documents:read',
  writeDocuments: 'documents:write',
  useGadgets: 'gadgets:use',
  manageGadgets: 'gadgets:manage',
  sendMessages: 'messages:send',
} as const

export type WorkspaceAction = typeof WorkspaceAction[keyof typeof WorkspaceAction]
export type CredentialKind = 'session' | 'mcp' | 'agent_runtime'

export type AuthorizationContext = {
  workspaceId: string
  principal: {
    id: string
    kind: UserKind
    roleId: string
    roleName: string
    permissions: number
    isOwner: boolean
  }
  credential: {
    kind: CredentialKind
    id?: string
    scopes?: McpScope[]
  }
  delegation?: {
    by: string
    actions?: WorkspaceAction[]
    permissions?: number
    isOwner?: boolean
    roleName?: string
  }
}

type ActionRule = { permission: PermissionFlag; scope?: McpScope }

const ACTION_RULES: Record<WorkspaceAction, ActionRule> = {
  [WorkspaceAction.readTasks]: { permission: Permission.manageTasks, scope: 'tasks:read' },
  [WorkspaceAction.writeTasks]: { permission: Permission.manageTasks, scope: 'tasks:write' },
  [WorkspaceAction.readDocuments]: { permission: Permission.manageDatabases, scope: 'documents:read' },
  [WorkspaceAction.writeDocuments]: { permission: Permission.manageDatabases, scope: 'documents:write' },
  [WorkspaceAction.useGadgets]: { permission: Permission.useGadgets },
  [WorkspaceAction.manageGadgets]: { permission: Permission.manageGadgets },
  [WorkspaceAction.sendMessages]: { permission: Permission.sendMessages },
}

export class AuthorizationError extends Error {
  readonly statusCode = 403
  readonly statusMessage: string
  readonly data: { error: { code: string; message: string } }

  constructor(message: string) {
    super(message)
    this.name = 'AuthorizationError'
    this.statusMessage = message
    this.data = { error: { code: 'forbidden', message } }
  }
}

/** The single workspace authorization boundary shared by HTTP, MCP, and Agents. */
export function authorize(context: AuthorizationContext, action: WorkspaceAction): void {
  const rule = ACTION_RULES[action]
  const delegatedAuthority = context.credential.kind === 'agent_runtime' && context.delegation?.permissions !== undefined
    ? {
        permissions: context.delegation.permissions,
        isOwner: context.delegation.isOwner === true,
        roleName: context.delegation.roleName || 'delegating member',
      }
    : context.principal
  if (!delegatedAuthority.isOwner && !hasPermission(delegatedAuthority.permissions, rule.permission)) {
    throw new AuthorizationError(`The ${delegatedAuthority.roleName} role cannot perform ${action}`)
  }
  if (context.credential.kind === 'mcp' && rule.scope && !context.credential.scopes?.includes(rule.scope)) {
    throw new AuthorizationError(`Access token is missing the ${rule.scope} scope`)
  }
  if (context.delegation?.actions && !context.delegation.actions.includes(action)) {
    throw new AuthorizationError(`The delegated Agent cannot perform ${action}`)
  }
}

export function auditAttribution(context: AuthorizationContext): Record<string, unknown> {
  return {
    principalKind: context.principal.kind,
    credentialKind: context.credential.kind,
    ...(context.credential.id ? { credentialId: context.credential.id } : {}),
    ...(context.delegation?.by ? { delegatedBy: context.delegation.by } : {}),
  }
}
