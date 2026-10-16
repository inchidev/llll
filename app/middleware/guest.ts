export default defineNuxtRouteMiddleware(async () => {
  const session = useSessionStore()
  const { api, native } = useApi()
  if (!session.ready) {
    const fetcher = import.meta.client && native ? api : asSessionFetcher(useRequestFetch())
    await session.refresh(fetcher)
  }
  if (session.user) return navigateTo('/')
  if (session.health && !session.health.ready) return navigateTo('/setup')
})
