import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { persistQueryClientRestore, persistQueryClientSubscribe, removeOldestQuery } from '@tanstack/query-persist-client-core'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { accountStorage, cachedQuery, clearBootCache, queriesStorageKey, readBootSnapshot } from '~/utils/boot-cache'
import type { ServerDTO } from '~~/shared/types'

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export default defineNuxtPlugin(async (nuxtApp) => {
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
    if (useClientServers().native === false) await keepQueriesAcrossLoads(queryClient, session, useRuntimeConfig().app.buildId)
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

/** A reload shows what this Account last saw, then every stale query refreshes as usual. */
async function keepQueriesAcrossLoads(queryClient: QueryClient, session: ReturnType<typeof useSessionStore>, buildId: string) {
  const options = (userId: string) => ({
    queryClient,
    buster: buildId,
    maxAge: CACHE_MAX_AGE_MS,
    persister: createSyncStoragePersister({ storage: accountStorage(() => !session.ready || session.user?.id === userId), key: queriesStorageKey(userId), throttleTime: 2000, retry: removeOldestQuery }),
    dehydrateOptions: { shouldDehydrateQuery: (query: { state: { status: string }, queryKey: readonly unknown[] }) => query.state.status === 'success' && cachedQuery(query.queryKey) },
  })
  const known = readBootSnapshot()?.user.id
  if (known) {
    try { await persistQueryClientRestore(options(known)) }
    catch { /* A damaged cache only means this load waits for the Server. */ }
  }
  let stop: (() => void) | undefined
  watch(() => session.user?.id, (userId) => {
    stop?.()
    stop = userId ? persistQueryClientSubscribe(options(userId)) : undefined
    if (!userId && session.ready) clearBootCache()
  }, { immediate: true })
}
