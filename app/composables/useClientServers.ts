import type { ClientServer } from '~~/shared/client-router'
export function useClientServers() {
  const connection = useServers()
  const clientMode = useRuntimeConfig().public.clientMode as string
  const servers = computed<ClientServer[]>(() =>
    connection.servers.value.map((s) => ({ origin: s.origin, name: s.name })),
  )
  function select(origin: string) {
    const server = connection.servers.value.find((s) => s.origin === origin)
    if (server) connection.select(origin, server.id)
  }
  return {
    clientMode,
    native: clientMode !== 'web',
    extension: clientMode === 'extension',
    servers,
    activeOrigin: connection.activeBase,
    initialize: connection.initialize,
    select,
    add: async (server: ClientServer) => {
      const d = await connection.discover(server.origin)
      connection.select(d.origin, d.id)
    },
    remove: connection.remove,
  }
}
