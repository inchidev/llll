import { z } from 'zod'

/** Reviewed origins and operations, not instructions or hints supplied by an MCP server. */
export const outboundMcpProviders = [{
  id: 'cloudflare-docs', name: 'Cloudflare documentation', endpoint: 'https://docs.mcp.cloudflare.com/mcp',
  readTools: ['search_cloudflare_documentation', 'migrate_pages_to_workers_guide'],
}, {
  id: 'deepwiki', name: 'DeepWiki public documentation', endpoint: 'https://mcp.deepwiki.com/mcp',
  readTools: ['read_wiki_structure', 'read_wiki_contents'],
}] as const

/** A connection whose URL the Server Owner entered. Its results are private to the Server. */
export const CUSTOM_MCP_PROVIDER = 'custom'
export const mcpCredentialHeaders = ['CF-Access-Client-Id', 'CF-Access-Client-Secret', 'X-API-Key'] as const

const specialUseSuffixes = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'test', 'invalid', 'onion', 'home.arpa']
/**
 * Why a custom endpoint is refused, or null. This is a rule about what may be saved, not a network
 * boundary: only the Owner enters a URL, and on their own host the Owner already controls the network.
 */
export function mcpEndpointProblem(value: string, serverOrigin?: string): string | null {
  if (value.length > 2048) return 'The URL is too long'
  let url: URL
  try { url = new URL(value) } catch { return 'Enter a complete https:// URL' }
  if (url.protocol !== 'https:') return 'The URL must use https://'
  if (url.username || url.password) return 'Put credentials in the credential field, not the URL'
  if (url.hash) return 'The URL cannot contain a fragment'
  // URL normalises alternative IPv4 spellings such as 0x7f.1 to dotted decimal.
  const host = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (host.startsWith('[') || /^[0-9.]+$/u.test(host)) return 'Use a domain name, not an IP address'
  if (!host.includes('.') || specialUseSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return 'Use a public domain name'
  if (serverOrigin && new URL(serverOrigin).hostname.toLowerCase() === host) return 'A Server cannot connect to itself'
  return null
}

const ids = z.array(z.string().uuid()).max(20)
const secretHeader = z.object({
  name: z.enum(mcpCredentialHeaders),
  value: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/u),
}).strict()
export const mcpConnectionInput = z.object({
  name: z.string().trim().min(1).max(60), providerId: z.enum(['cloudflare-docs', 'deepwiki', CUSTOM_MCP_PROVIDER]),
  endpoint: z.string().trim().max(2048).optional(), description: z.string().trim().max(300).default(''),
  ownership: z.enum(['server', 'member']), enabled: z.boolean().default(false),
  grants: z.object({ agentIds: ids, memberIds: ids, roleIds: ids }).strict(),
  // A custom connection is saved first and its tools chosen after L4 has listed them.
  toolNames: z.array(z.string().min(1).max(100)).max(40),
  credential: z.string().min(1).max(8192).regex(/^[A-Za-z0-9._~+/-]+=*$/u).nullable().optional(),
  credentialHeaders: z.array(secretHeader).min(1).max(2).optional(),
  credentialExpiresAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict()
export type McpConnectionInput = z.input<typeof mcpConnectionInput>
export type McpConnectionGrant = McpConnectionInput['grants']
export type McpToolSnapshot = { name: string; remoteName: string; description: string; parameters: Record<string, unknown>; hash: string; declaredReadOnly?: boolean }
export type McpAuthKind = 'none' | 'bearer' | 'headers'
export type McpConnectionDTO = {
  id: string; name: string; providerId: string; endpoint: string | null; description: string; authKind: McpAuthKind; ownership: 'server' | 'member'; enabled: boolean; revision: number
  grants: McpConnectionGrant; toolNames: string[]; tools: McpToolSnapshot[]; hasCredential: boolean
  credentialExpiresAt: string | null; checkedAt: string | null; lastError: string | null
}

/**
 * The x402 MCP transport asks for payment with a failed tool result that carries `x402Version` and
 * `accepts`. Parsed strictly: anything else stays an ordinary failure, and remote text never reaches the model.
 */
export function mcpPaymentRequired(result: { structuredContent?: unknown; content?: unknown }): boolean {
  const matches = (value: unknown) => {
    if (!value || typeof value !== 'object') return false
    const { x402Version, accepts } = value as { x402Version?: unknown; accepts?: unknown }
    return typeof x402Version === 'number' && Array.isArray(accepts) && accepts.length > 0
  }
  if (matches(result.structuredContent)) return true
  const first = Array.isArray(result.content) ? result.content[0] as { type?: unknown; text?: unknown } | undefined : undefined
  if (first?.type !== 'text' || typeof first.text !== 'string' || first.text.length > 16000) return false
  try { return matches(JSON.parse(first.text)) } catch { return false }
}
