import type { PublicUser } from './types'

export const MCP_SCOPES = [
  'tasks:read',
  'tasks:write',
  'documents:read',
  'documents:write',
] as const

export type McpScope = typeof MCP_SCOPES[number]

export const MCP_SCOPE_LABELS: Record<McpScope, string> = {
  'tasks:read': 'Read tasks',
  'tasks:write': 'Create and update tasks',
  'documents:read': 'Read documents',
  'documents:write': 'Create and update documents',
}

export type McpConnectionDTO = {
  id: string
  clientId: string
  clientName: string
  subject: PublicUser
  createdBy: string
  scopes: McpScope[]
  createdAt: string
  lastUsedAt: string | null
}

export type McpConsentDTO = {
  clientName: string
  clientId: string
  redirectUri: string
  scopes: McpScope[]
  offlineAccess: boolean
  subjects: Array<PublicUser & { scopes: McpScope[] }>
}

export type McpAccessTokenDTO = {
  id: string
  name: string
  tokenPrefix: string
  scopes: McpScope[]
  subject: PublicUser
  createdBy: PublicUser
  lastUsedAt: string | null
  createdAt: string
}

export type CreatedMcpAccessTokenDTO = McpAccessTokenDTO & {
  token: string
}
