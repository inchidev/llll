import type { AdminSession } from '../composables/useAdmin'

/** Everything except sign-in and claim needs the owner session. */
export default defineNuxtRouteMiddleware(async (to) => {
  const session = useState<AdminSession | null>('admin-session', () => null)
  const fetch = useRequestFetch()
  session.value = await fetch<AdminSession>('/api/session').catch(() => null)
  if (to.path === '/claim') return
  if (!session.value?.claimed) return navigateTo('/claim')
  if (to.path === '/login' || to.path === '/recover') {
    if (session.value.owner) return navigateTo('/')
    return
  }
  if (!session.value.owner) return navigateTo('/login')
})
