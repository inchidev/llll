import { SERVER_API_VERSION, type ServerDiscovery } from './server'
import { serverAppearance } from './server-appearance'
import { normalizeServerOrigin } from './server-origins'

function listedOrigins(value: unknown, primary: string): string[] {
  if (!Array.isArray(value)) return []
  const origins: string[] = []
  for (const item of value.slice(0, 20)) {
    if (typeof item !== 'string') continue
    try {
      const origin = normalizeServerOrigin(item)
      if (origin !== primary && !origins.includes(origin)) origins.push(origin)
    }
    catch {
      // Ignore a malformed optional alias rather than rejecting the Server.
    }
  }
  return origins
}

export function serverDiscovery(value: unknown, origin: string): ServerDiscovery {
  const data = value as Partial<ServerDiscovery> | null
  if (!data || data.product !== 'llll' || data.kind !== 'server' || data.apiVersion !== SERVER_API_VERSION || typeof data.ready !== 'boolean')
    throw new Error('This address is not a compatible L4 Server')
  let primary: string
  try {
    primary = normalizeServerOrigin(data.origin || '')
  }
  catch {
    throw new Error('This address is not a compatible L4 Server')
  }
  const aliases = listedOrigins(data.aliases, primary)
  if (primary !== origin && !aliases.includes(origin))
    throw new Error('This address is not a compatible L4 Server')
  return {
    product: 'llll',
    kind: 'server',
    ...serverAppearance(data, origin),
    apiVersion: SERVER_API_VERSION,
    origin: primary,
    aliases,
    ready: data.ready,
    version: data.version || '',
    registration: data.registration === true,
    telegram: data.telegram === true,
    embedOrigins: Array.isArray(data.embedOrigins) ? data.embedOrigins.filter(item => typeof item === 'string').slice(0, 100) : [],
  }
}
