import type { BrowserPushSubscription, PushConfig } from '~~/shared/notifications'

export type PushNotificationStatus = 'unsupported' | 'unconfigured' | 'prompt' | 'subscribed' | 'blocked' | 'error'

function decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const raw = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(raw, char => char.charCodeAt(0))
}

function equalKeys(a: ArrayBuffer | null, b: Uint8Array<ArrayBuffer>): boolean {
  if (!a) return false
  const left = new Uint8Array(a)
  return left.length === b.length && left.every((value, index) => value === b[index])
}

function subscriptionJson(subscription: PushSubscription): BrowserPushSubscription | null {
  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return null
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  }
}

export function usePushNotifications() {
  const { native } = useClientServers()
  const status = ref<PushNotificationStatus>('prompt')
  const busy = ref(false)
  const error = ref<string | null>(null)
  let config: PushConfig | null = null

  function nativeNotifications() {
    return native ? window.__LLLL_NATIVE_NOTIFICATIONS__ : undefined
  }

  function supported() {
    return !native && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  }

  async function registration() {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    return navigator.serviceWorker.ready
  }

  async function loadConfig() {
    config = await $fetch<PushConfig>('/api/push/config')
    return config
  }

  async function refresh() {
    error.value = null
    const bridge = nativeNotifications()
    if (bridge) {
      try { status.value = await bridge.status() }
      catch (cause) {
        error.value = errorMessage(cause)
        status.value = 'error'
      }
      return
    }
    if (!supported()) {
      status.value = 'unsupported'
      return
    }
    try {
      const currentConfig = await loadConfig()
      if (!currentConfig.configured || !currentConfig.publicKey) {
        status.value = 'unconfigured'
        return
      }
      if (Notification.permission === 'denied') {
        status.value = 'blocked'
        return
      }
      const current = await (await registration()).pushManager.getSubscription()
      status.value = current ? 'subscribed' : 'prompt'
    }
    catch (cause) {
      error.value = errorMessage(cause)
      status.value = 'error'
    }
  }

  async function enable() {
    busy.value = true
    error.value = null
    let created: PushSubscription | null = null
    try {
      const bridge = nativeNotifications()
      if (bridge) {
        status.value = await bridge.enable()
        return
      }
      if (!supported()) throw new Error('Notifications are not available in this browser')
      const currentConfig = config ?? await loadConfig()
      if (!currentConfig.configured || !currentConfig.publicKey) throw new Error('Web Push is not configured')
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        status.value = 'blocked'
        return
      }
      const key = decodeApplicationServerKey(currentConfig.publicKey)
      const ready = await registration()
      let subscription = await ready.pushManager.getSubscription()
      if (subscription && !equalKeys(subscription.options.applicationServerKey, key)) {
        await subscription.unsubscribe()
        subscription = null
      }
      if (!subscription) {
        subscription = await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        created = subscription
      }
      const body = subscriptionJson(subscription)
      if (!body) throw new Error('Browser returned an incomplete push subscription')
      await $fetch('/api/push/subscriptions', { method: 'PUT', body })
      status.value = 'subscribed'
    }
    catch (cause) {
      if (created) await created.unsubscribe().catch(() => false)
      error.value = errorMessage(cause)
      status.value = 'error'
      throw cause
    }
    finally {
      busy.value = false
    }
  }

  async function disable() {
    const bridge = nativeNotifications()
    if (bridge) {
      busy.value = true
      try {
        await bridge.disable()
        status.value = 'prompt'
      }
      finally {
        busy.value = false
      }
      return
    }
    if (!supported()) return
    busy.value = true
    error.value = null
    try {
      const subscription = await (await registration()).pushManager.getSubscription()
      if (subscription) {
        try {
          await $fetch('/api/push/subscriptions', { method: 'DELETE', body: { endpoint: subscription.endpoint } })
        }
        finally {
          await subscription.unsubscribe()
        }
      }
      status.value = 'prompt'
    }
    catch (cause) {
      error.value = errorMessage(cause)
      status.value = 'error'
      throw cause
    }
    finally {
      busy.value = false
    }
  }

  return { status, busy, error, refresh, enable, disable }
}
