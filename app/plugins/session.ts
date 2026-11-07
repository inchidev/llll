import type { QueryClient } from '@tanstack/vue-query'
import { readBootSnapshot } from '~/utils/boot-cache'

export default defineNuxtPlugin(async (nuxtApp) => {
  const session = useSessionStore()
  const { api, native, serverOrigin } = useApi()
  if (session.ready) return
  if (import.meta.client && native && !serverOrigin.value) return
  // Typed separately: inferring one union of both route-typed fetchers exceeds TypeScript's instantiation depth.
  const fetcher = import.meta.client && native ? asSessionFetcher(api) : asSessionFetcher(useRequestFetch() as unknown)
  // A bundled Client serves several Servers from one origin, so only a Server's own Client reuses its last session.
  const snapshot = import.meta.client && !native ? readBootSnapshot() : null
  if (!snapshot) return await session.refresh(fetcher)
  session.restore(snapshot)
  const router = useRouter()
  void session.revalidate(fetcher).then((result) => {
    if (result === 'current') return
    ;(nuxtApp.$queryClient as QueryClient).clear()
    if (result === 'changed') return location.reload()
    const { fullPath } = router.currentRoute.value
    return router.replace({ path: '/login', query: { next: fullPath } })
  })
})
