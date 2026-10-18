export const INSTALLATION_API_VERSION = 1

export type InstanceDiscovery = {
  product: 'llll'
  kind: 'installation' | 'server' | 'client'
  id: string
  name: string
  apiVersion: number
  version: string
  origin: string
  registration: boolean
  telegram: boolean
  telegramOidc?: boolean
  identity?: boolean
  embedOrigins?: string[]
}

export type InstanceServer = {
  publicId?: string
  id: string
  name: string
  ownerId: string
  version: string
  status: 'provisioning' | 'ready' | 'failed'
  error?: string
  /** The server's own origin while provisioning; the browser verifies its health from there because the installation Worker cannot fetch same-account workers.dev URLs. */
  origin?: string
  assetToken?: string
}

export type ConnectedInstance = {
  origin: string
  id: string
  name: string
  kind: InstanceDiscovery['kind']
  servers: InstanceServer[]
  userId?: string
  collapsed?: boolean
}

export function serverBase(origin: string, serverId: string, kind: InstanceDiscovery['kind'] = 'installation') {
  return kind === 'server' ? origin : `${origin}/s/${encodeURIComponent(serverId)}`
}

export function connectionScope(origin: string, serverId: string, userId = '') {
  return `${new URL(origin).origin}/${encodeURIComponent(serverId)}/${encodeURIComponent(userId)}`
}
