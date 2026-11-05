import type { L4Env } from '../../workers/env'
import { withIntegrations } from '../../workers/integrations'

/** Every API request reads the Owner's saved settings through `cf(event).env`. */
export default defineEventHandler(async event => {
  const path = (event.path || '').split('?')[0]!
  if (!path.startsWith('/api/') && path !== '/mcp') return
  const box = (event.context.cloudflare ?? (event.context._platform as { cloudflare?: unknown } | undefined)?.cloudflare) as { env?: L4Env } | undefined
  if (box?.env?.DB) box.env = await withIntegrations(box.env)
})
