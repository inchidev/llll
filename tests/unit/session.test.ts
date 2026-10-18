import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { useSessionStore as SessionStoreFactory } from '../../app/stores/session'

let useSessionStore: typeof SessionStoreFactory

beforeAll(async () => {
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('useServers', () => ({ tokens: ref({}) }))
  ;({ useSessionStore } = await import('../../app/stores/session'))
})

describe('session transport', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('uses the request-aware fetcher supplied by the Nuxt request context', async () => {
    const session = useSessionStore()
    const requestFetch = vi.fn(async (path: string) => {
      if (path === '/api/setup/health') {
        return { users: 1, twitterAuth: false }
      }
      if (path === '/api/me') {
        return {
          user: {
            id: 'user-1',
            displayName: 'Owner',
            avatarR2Key: null,
            email: 'owner@example.com',
          },
        }
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    await Reflect.apply(session.refresh, session, [requestFetch])

    expect(requestFetch).toHaveBeenCalledWith('/api/setup/health')
    expect(requestFetch).toHaveBeenCalledWith('/api/me')
    expect(session.user?.id).toBe('user-1')
    expect(session.ready).toBe(true)
  })

  it('uses the supplied client fetcher for login and logout', async () => {
    const session = useSessionStore()
    const clientFetch = vi.fn(async (path: string) => {
      if (path === '/api/auth/login') {
        return {
          user: {
            id: 'user-1',
            displayName: 'Owner',
            avatarR2Key: null,
            email: 'owner@example.com',
          },
        }
      }
      if (path === '/api/auth/logout') return undefined
      throw new Error(`Unexpected path: ${path}`)
    })

    await Reflect.apply(session.login, session, ['owner@example.com', 'password12', clientFetch])
    expect(clientFetch).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'password12' },
    })
    expect(session.user?.id).toBe('user-1')

    await Reflect.apply(session.logout, session, [clientFetch])
    expect(clientFetch).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' })
    expect(session.user).toBeNull()
  })
})
