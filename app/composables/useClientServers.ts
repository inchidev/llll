import type { ClientMode, ClientServer } from '~~/shared/client-router'

export function useClientServers() {
  const connections = useInstances()
  const clientMode = useRuntimeConfig().public.clientMode as ClientMode
  const servers = computed<ClientServer[]>(() => connections.installations.value.flatMap(installation => installation.servers.map(server => ({ origin: installation.kind === 'server' ? installation.origin : `${installation.origin}/s/${server.id}`, name: server.name }))))
  function select(base: string) {
    for (const installation of connections.installations.value) {
      const server = installation.servers.find(item => (installation.kind === 'server' ? installation.origin : `${installation.origin}/s/${item.id}`) === base)
      if (server) { connections.select(installation.origin, server.id); return }
    }
  }
  return { clientMode, native: true, extension: clientMode === 'extension', servers, activeOrigin: connections.activeBase, initialize: connections.initialize, select, add: async (server: ClientServer) => { const discovery = await connections.discover(server.origin); if (discovery.kind === 'server') connections.select(discovery.origin, discovery.id) }, remove: connections.remove }
}
