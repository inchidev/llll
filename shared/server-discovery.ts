import { SERVER_API_VERSION, type ServerDiscovery } from './server'
import { serverAppearance } from './server-appearance'

export function serverDiscovery(value: unknown, origin: string): ServerDiscovery {
  const data = value as Partial<ServerDiscovery> | null
  if (!data || data.product !== 'llll' || data.kind !== 'server' || data.apiVersion !== SERVER_API_VERSION || data.origin !== origin || typeof data.ready !== 'boolean')
    throw new Error('This address is not a compatible L4 Server')
  return { product: 'llll', kind: 'server', ...serverAppearance(data, origin), apiVersion: SERVER_API_VERSION, origin, ready: data.ready, version: data.version || '', registration: data.registration === true, telegram: data.telegram === true, embedOrigins: Array.isArray(data.embedOrigins) ? data.embedOrigins.filter(item => typeof item === 'string').slice(0, 100) : [] }
}
