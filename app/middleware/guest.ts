export default defineNuxtRouteMiddleware(async to => {
  const session = useSessionStore()
  const { api, native } = useApi()
  if (!session.ready) {
    const fetcher = import.meta.client && native ? api : asSessionFetcher(useRequestFetch())
    await session.refresh(fetcher)
  }
  if (session.user) { const next = typeof to.query.return_to === 'string' ? to.query.return_to : '/'; return navigateTo(next.startsWith('/') && !next.startsWith('//') ? next : '/', { external: next.startsWith('/api/auth/connection/authorize?') }) }
  if (session.health && !session.health.ready) return navigateTo('/setup')
})
