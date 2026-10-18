export const SERVER_API_VERSION = 1
export type ServerDiscovery = {
  product: 'llll'
  kind: 'server'
  id: string
  name: string
  apiVersion: number
  version: string
  origin: string
  registration: boolean
  telegram: boolean
  embedOrigins: string[]
  ready: boolean
}
export type ConnectedServer = {
  origin: string
  id: string
  name: string
  version: string
  userId?: string
}
export function connectionScope(origin: string, serverId: string, userId = '') {
  return `${new URL(origin).origin}/${encodeURIComponent(serverId)}/${encodeURIComponent(userId)}`
}
