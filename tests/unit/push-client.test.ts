import { afterEach, expect, it, vi } from 'vitest'
import { usePushNotifications } from '../../app/composables/usePushNotifications.client'

afterEach(() => vi.unstubAllGlobals())

it('prepares the Server identity before subscribing immediately in the click handler', async () => {
  const subscription = { toJSON: () => ({ endpoint: 'https://push.example/sub', keys: { p256dh: 'key', auth: 'auth' } }) }
  const subscribe = vi.fn(async () => subscription)
  const registration = { pushManager: { getSubscription: vi.fn(async () => null), subscribe } }
  const fetch = vi.fn(async (_url: string, options?: { method?: string }) => options?.method === 'PUT'
    ? { subscribed: true }
    : { configured: true, publicKey: options?.method === 'POST' ? 'AQID' : null })
  vi.stubGlobal('ref', (value: unknown) => ({ value }))
  vi.stubGlobal('useClientServers', () => ({ native: false }))
  vi.stubGlobal('plainFetch', fetch)
  vi.stubGlobal('window', { PushManager: {}, Notification: {} })
  vi.stubGlobal('Notification', { permission: 'default' })
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => registration), ready: Promise.resolve(registration) } })
  const push = usePushNotifications()
  await push.refresh()
  expect(fetch).toHaveBeenCalledWith('/api/push/config', { method: 'POST' })
  const enabling = push.enable()
  expect(subscribe).toHaveBeenCalledOnce()
  await enabling
  expect(push.status.value).toBe('subscribed')
  expect(fetch).toHaveBeenCalledWith('/api/push/subscriptions', expect.objectContaining({ method: 'PUT' }))
})
