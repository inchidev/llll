export const INSTALLATION_API_VERSION = 1

export type InstallationDiscovery = {
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
}

export type InstallationServer = {
  id: string
  name: string
  ownerId: string
  version: string
  status: 'provisioning' | 'ready' | 'failed'
  assetToken?: string
}

export type ConnectedInstallation = {
  origin: string
  id: string
  name: string
  kind: InstallationDiscovery['kind']
  servers: InstallationServer[]
  userId?: string
  collapsed?: boolean
}

export function serverBase(origin: string, serverId: string, kind: InstallationDiscovery['kind'] = 'installation') {
  return kind === 'server' ? origin : `${origin}/s/${encodeURIComponent(serverId)}`
}

export function connectionScope(origin: string, serverId: string, userId = '') {
  return `${new URL(origin).origin}/${encodeURIComponent(serverId)}/${encodeURIComponent(userId)}`
}
