import { defineStore } from 'pinia'
import type { SessionUser, SetupHealth } from '~~/shared/types'

type SessionFetcher = (request: string, options?: {
  method?: 'POST'
  body?: { email: string, password: string }
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
  }

  async function login(email: string, password: string, fetcher: SessionFetcher = asSessionFetcher($fetch)) {
    const res = await fetcher('/api/auth/login', { method: 'POST', body: { email, password } }) as { user: SessionUser }
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
    return response?.redirect || null
  }

  return { user, health, ready, refresh, signedIn, login, logout }
})
