import { z } from 'zod'

/** Reviewed origins and operations, not instructions or hints supplied by an MCP server. */
export const outboundMcpProviders = [{
  id: 'cloudflare-docs', name: 'Cloudflare documentation', endpoint: 'https://docs.mcp.cloudflare.com/mcp',
  readTools: ['search_cloudflare_documentation', 'migrate_pages_to_workers_guide'],
}, {
  id: 'deepwiki', name: 'DeepWiki public documentation', endpoint: 'https://mcp.deepwiki.com/mcp',
  readTools: ['read_wiki_structure', 'read_wiki_contents'],
}] as const

const ids = z.array(z.string().uuid()).max(20)
export const mcpConnectionInput = z.object({
  name: z.string().trim().min(1).max(60), providerId: z.enum(['cloudflare-docs', 'deepwiki']),
  ownership: z.enum(['server', 'member']), enabled: z.boolean().default(false),
  grants: z.object({ agentIds: ids, memberIds: ids, roleIds: ids }).strict(),
  toolNames: z.array(z.string().min(1).max(100)).min(1).max(10),
  credential: z.string().min(1).max(8192).regex(/^[A-Za-z0-9._~+/-]+=*$/u).nullable().optional(),
  credentialExpiresAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict()
export type McpConnectionInput = z.infer<typeof mcpConnectionInput>
export type McpConnectionGrant = McpConnectionInput['grants']
export type McpToolSnapshot = { name: string; remoteName: string; description: string; parameters: Record<string, unknown>; hash: string }
export type McpConnectionDTO = {
  id: string; name: string; providerId: string; ownership: 'server' | 'member'; enabled: boolean; revision: number
  grants: McpConnectionGrant; toolNames: string[]; tools: McpToolSnapshot[]; hasCredential: boolean
  credentialExpiresAt: string | null; checkedAt: string | null; lastError: string | null
}
