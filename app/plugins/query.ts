import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import type { ServerDTO } from '~~/shared/types'

export default defineNuxtPlugin((nuxtApp) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: 4,
        retryDelay: attempt => Math.min(250 * 2 ** attempt, 2000),
        refetchOnWindowFocus: true,
      },
    },
  })
  nuxtApp.vueApp.use(VueQueryPlugin, { queryClient })
  if (typeof window !== 'undefined') {
    const connection = useServers()
    const session = useSessionStore()
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (event.type !== 'updated' || event.query.queryKey[0] !== 'server') return
      const data = event.query.state.data as { server?: ServerDTO } | undefined
      if (data?.server && event.query.queryKey[1] === data.server.id) {
        connection.updateAppearance(location.origin, data.server)
        if (session.health && connection.activeServer.value?.id === data.server.id) {
          session.health.appName = data.server.name
          session.health.iconUrl = connection.activeServer.value.iconUrl
        }
      }
    })
    nuxtApp.vueApp.onUnmount(unsubscribe)
  }
  return { provide: { queryClient } }
})
