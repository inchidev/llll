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
    ready.value = true
  }

  async function login(email: string, password: string, fetcher: SessionFetcher = asSessionFetcher($fetch)) {
    const res = await fetcher('/api/auth/login', { method: 'POST', body: { email, password } }) as { user: SessionUser }
    user.value = res.user
  }

  async function logout(fetcher: SessionFetcher = asSessionFetcher($fetch)) {
    const connections = useInstallations()
    if (connections.activeInstallation.value?.kind === 'installation') {
      await connections.logout(connections.activeInstallation.value.origin)
      user.value = null
      return '/connections'
    }
    const response = await fetcher('/api/auth/logout', { method: 'POST' }) as { redirect?: string | null } | undefined
    user.value = null
    return response?.redirect || null
  }

  return { user, health, ready, refresh, login, logout }
})
