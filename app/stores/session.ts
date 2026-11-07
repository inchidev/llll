import { defineStore } from 'pinia'
import type { SessionUser, SetupHealth } from '~~/shared/types'
import { clearBootCache, saveBootSnapshot, type BootSnapshot } from '~/utils/boot-cache'

type SessionFetcher = (request: string, options?: {
  method?: 'POST'
  body?: { login: string, password: string }
}) => Promise<unknown>

export function asSessionFetcher(fetcher: unknown): SessionFetcher {
  return fetcher as SessionFetcher
}

export const useSessionStore = defineStore('session', () => {
  const user = ref<SessionUser | null>(null)
  const health = ref<SetupHealth | null>(null)
  const ready = ref(false)

  async function refresh(fetcher: SessionFetcher = asSessionFetcher($fetch)) {
    const [healthResult, meResult] = await Promise.allSettled([
      fetcher('/api/setup/health') as Promise<SetupHealth>,
      fetcher('/api/me') as Promise<{ user: SessionUser }>,
    ])
    health.value = healthResult.status === 'fulfilled' ? healthResult.value : null
    user.value = meResult.status === 'fulfilled' ? meResult.value.user : null
    await memberDetails(fetcher)
    ready.value = true
    remember()
  }

  /** Shows the last known session at once. `revalidate` then asks the Server. */
  function restore(snapshot: BootSnapshot) {
    user.value = snapshot.user
    health.value = snapshot.health
    ready.value = true
  }

  /**
   * Only the Server saying the session ended signs this Client out: a network failure keeps what
   * is on screen, as the next request will tell. Another Account in this browser starts again.
   */
  async function revalidate(fetcher: SessionFetcher = asSessionFetcher($fetch)): Promise<'current' | 'ended' | 'changed'> {
    const shown = user.value?.id
    const [healthResult, meResult] = await Promise.allSettled([
      fetcher('/api/setup/health') as Promise<SetupHealth>,
      fetcher('/api/me') as Promise<{ user: SessionUser }>,
    ])
    if (meResult.status === 'rejected') {
      if ((meResult.reason as { status?: number } | null)?.status !== 401) return 'current'
      clearBootCache()
      user.value = null
      return 'ended'
    }
    if (healthResult.status === 'fulfilled') health.value = healthResult.value
    user.value = meResult.value.user
    if (meResult.value.user.id !== shown) {
      clearBootCache()
      return 'changed'
    }
    remember()
    return 'current'
  }

  function remember() {
    if (user.value && health.value?.ready) saveBootSnapshot({ user: user.value, health: health.value })
  }

  /**
   * Public health omits runtime details (bindings, capabilities, Live). Fetch
   * them again once a session exists, e.g. right after sign-in.
   */
  async function memberDetails(fetcher: SessionFetcher) {
    if (!user.value || !health.value?.ready || health.value.capabilities) return
    try { health.value = await fetcher('/api/setup/health') as SetupHealth }
    catch { /* Keep the public health; feature checks treat details as unknown. */ }
  }

  async function signedIn(next: SessionUser | null, fetcher: SessionFetcher = asSessionFetcher($fetch)) {
    user.value = next
    await memberDetails(fetcher)
    remember()
  }

  async function login(identifier: string, password: string, fetcher: SessionFetcher = asSessionFetcher($fetch)) {
    const res = await fetcher('/api/auth/login', { method: 'POST', body: { login: identifier, password } }) as { user: SessionUser }
    await signedIn(res.user, fetcher)
  }

  async function logout(fetcher: SessionFetcher = asSessionFetcher($fetch)) {
    const response = await fetcher('/api/auth/logout', { method: 'POST' }) as { redirect?: string | null } | undefined
    if (import.meta.client && typeof window !== 'undefined') {
      const connection = useServers()
      Reflect.deleteProperty(connection.tokens.value, window.location.origin)
      try { sessionStorage.removeItem('llll.server-session:' + window.location.origin) } catch { /* In-memory sessions are cleared above. */ }
    }
    user.value = null
    clearBootCache()
    return response?.redirect || null
  }

  return { user, health, ready, refresh, restore, revalidate, signedIn, login, logout }
})
