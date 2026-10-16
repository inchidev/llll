import type { PublicUser } from './types'

export const MCP_SCOPES = [
  'tasks:read',
  'tasks:write',
  'documents:read',
  'documents:write',
] as const

export type McpScope = typeof MCP_SCOPES[number]

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
