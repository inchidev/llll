export default defineNuxtRouteMiddleware(async (to) => {
  const session = useSessionStore()
  const { api, native } = useApi()
  if (!session.ready) {
    if (import.meta.client && native) await session.refresh(api)
    else await session.refresh(asSessionFetcher(useRequestFetch()))
  }
  if (!session.user) {
    if (useInstallations().activeInstallation.value?.kind === 'installation') return navigateTo('/connections')
    return navigateTo({ path: '/login', query: { next: to.fullPath } })
  }
  if (session.user.onboardingRequired && to.path !== '/signup/accept') {
    return navigateTo({ path: '/signup/accept', query: { next: to.fullPath } })
  }
})
