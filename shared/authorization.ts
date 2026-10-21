import { resourceAccessAllows, type ResourceAccess, type ResourceKind } from './resource-access'
import type { McpScope } from './mcp'
import { hasPermission, Permission, type PermissionFlag } from './permissions'
import type { UserKind } from './types'

export const ServerAction = {
  executeTasks: 'tasks:execute',
  manageSchedules: 'schedules:manage',
  browseWeb: 'web:read',
  readRecords: 'data:read',
  writeRecords: 'data:write',
  readTasks: 'tasks:read',
  writeTasks: 'tasks:write',
  readDocuments: 'documents:read',
  writeDocuments: 'documents:write',
  useGadgets: 'gadgets:use',
  manageGadgets: 'gadgets:manage',
  sendMessages: 'messages:send',
} as const

export type ServerAction = typeof ServerAction[keyof typeof ServerAction]
export type CredentialKind = 'session' | 'mcp' | 'agent_runtime'

export type AuthorizationContext = {
  serverId: string
  principal: {
    id: string
    kind: UserKind
    roleId: string
    roleName: string
    permissions: number
    resourceAccess?: ResourceAccess
    isOwner: boolean
  }
  credential: {
    kind: CredentialKind
    id?: string
    scopes?: McpScope[]
    clientId?: string
  }
  delegation?: {
    by: string
    actions?: ServerAction[]
    permissions?: number
    resourceAccess?: ResourceAccess
    isOwner?: boolean
    roleName?: string
  }
}

type ActionRule = { permission: PermissionFlag; scope?: McpScope }

const ACTION_RULES: Record<ServerAction, ActionRule> = {
  [ServerAction.executeTasks]: { permission: Permission.executeTasks },
  [ServerAction.manageSchedules]: { permission: Permission.manageSchedules },
  [ServerAction.browseWeb]: { permission: Permission.browseWeb },
  [ServerAction.readRecords]: { permission: Permission.readData, scope: 'data:read' },
  [ServerAction.writeRecords]: { permission: Permission.writeData, scope: 'data:write' },
  [ServerAction.readTasks]: { permission: Permission.readTasks, scope: 'tasks:read' },
  [ServerAction.writeTasks]: { permission: Permission.writeTasks, scope: 'tasks:write' },
  [ServerAction.readDocuments]: { permission: Permission.readData, scope: 'documents:read' },
  [ServerAction.writeDocuments]: { permission: Permission.writeData, scope: 'documents:write' },
  [ServerAction.useGadgets]: { permission: Permission.useGadgets },
  [ServerAction.manageGadgets]: { permission: Permission.manageGadgets },
  [ServerAction.sendMessages]: { permission: Permission.sendMessages, scope: 'messages:write' },
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

/** Credential limits are separate from channel-specific permissions and DM rules. */
export function authorizeMcpCredential(context: AuthorizationContext, scope?: McpScope): void {
  if (context.credential.kind !== 'mcp') return
  if (!context.principal.isOwner && !hasPermission(context.principal.permissions, Permission.mcpConnect)) {
    throw new AuthorizationError(`The ${context.principal.roleName} role cannot perform mcp.connect`)
  }
  if (scope && !context.credential.scopes?.includes(scope)) {
    throw new AuthorizationError(`Access token is missing the ${scope} scope`)
  }
}

/** The single server authorization boundary shared by HTTP, MCP, and Agents. */
export function authorize(context: AuthorizationContext, action: ServerAction): void {
  authorizeMcpCredential(context)
  const rule = ACTION_RULES[action]
  if (!context.principal.isOwner && !hasPermission(context.principal.permissions, rule.permission)) {
    throw new AuthorizationError(`The ${context.principal.roleName} role cannot perform ${action}`)
  }
  if (context.delegation?.permissions !== undefined && !context.delegation.isOwner
    && !hasPermission(context.delegation.permissions, rule.permission)) {
    throw new AuthorizationError(`The delegating ${context.delegation.roleName || 'member'} cannot perform ${action}`)
  }
  authorizeMcpCredential(context, rule.scope)
  if (context.delegation?.actions && !context.delegation.actions.includes(action)) {
    throw new AuthorizationError(`The delegated Agent cannot perform ${action}`)
  }
}

export function auditAttribution(context: AuthorizationContext): Record<string, unknown> {
  return {
    principalKind: context.principal.kind,
    credentialKind: context.credential.kind,
    ...(context.credential.id ? { credentialId: context.credential.id } : {}),
    ...(context.credential.clientId ? { clientId: context.credential.clientId } : {}),
    ...(context.delegation?.by ? { delegatedBy: context.delegation.by } : {}),
  }
}

/** Resource access is checked separately so list operations can filter before disclosure. */
export function resourceAllowed(context: AuthorizationContext, kind: ResourceKind, id: string): boolean {
  return (context.principal.isOwner || resourceAccessAllows(context.principal.resourceAccess, kind, id))
    && resourceAccessAllows(context.delegation?.resourceAccess, kind, id)
}

export function authorizeResource(context: AuthorizationContext, kind: ResourceKind, id: string): void {
  if (!resourceAllowed(context, kind, id)) throw new AuthorizationError(`Access to this ${kind} resource is not granted`)
}
