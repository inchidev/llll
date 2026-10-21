import { MCP_SCOPES } from '../../../../shared/mcp'
import { mcpOrigin } from '../../../utils/mcp-consent'

export default defineEventHandler((event) => {
  const origin = mcpOrigin(event)
  setHeader(event, 'Access-Control-Allow-Origin', '*')
  return { resource: `${origin}/mcp`, authorization_servers: [`${origin}/api/auth`],
    scopes_supported: [...MCP_SCOPES, 'offline_access'], bearer_methods_supported: ['header'], resource_name: 'L4 MCP' }
})
