export default defineNuxtRouteMiddleware(async (to) => {
  const session = useSessionStore()
  const { api, native } = useApi()
  if (!session.ready) {
    const fetcher = import.meta.client && native ? api : asSessionFetcher(useRequestFetch())
    await session.refresh(fetcher)
  }
  if (!session.user) {
    return navigateTo({ path: '/login', query: { next: to.fullPath } })
  }
  if (session.user.onboardingRequired && to.path !== '/signup/accept') {
    return navigateTo({ path: '/signup/accept', query: { next: to.fullPath } })
  }
})
