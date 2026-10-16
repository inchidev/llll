import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { openUrl } from '@tauri-apps/plugin-opener'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

const webFetch = globalThis.fetch.bind(globalThis)
const titlebarSafeArea = '2.25rem'
const serverRailWidth = '5rem'
const notificationsKey = 'df:native-notifications-enabled'

function notificationId(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index++) hash = ((hash * 31) + value.charCodeAt(index)) | 0
  return Math.abs(hash % 2147483647) || 1
}

function openInternalRoute(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return
  window.location.assign(value)
}

async function notificationStatus(): Promise<'prompt' | 'subscribed' | 'blocked' | 'error'> {
  try {
    const granted = await isPermissionGranted()
    return granted && localStorage.getItem(notificationsKey) === 'true' ? 'subscribed' : 'prompt'
  }
  catch {
    return 'error'
  }
}

window.__LLLL_NATIVE_NOTIFICATIONS__ = {
  status: notificationStatus,
  async enable() {
    let granted = await isPermissionGranted()
    if (!granted) granted = await requestPermission() === 'granted'
    if (!granted) return 'blocked'
    localStorage.setItem(notificationsKey, 'true')
    return 'subscribed'
  },
  async disable() {
    localStorage.setItem(notificationsKey, 'false')
    await getCurrentWindow().setBadgeCount().catch(() => undefined)
  },
  async setBadge(count) {
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined)
  },
  async notify(notification) {
    if (localStorage.getItem(notificationsKey) !== 'true' || !await isPermissionGranted()) return
    sendNotification({
      id: notificationId(notification.id),
      title: notification.title,
      body: notification.body,
      group: 'messages',
      extra: { url: notification.url },
    })
  },
}

void onAction(notification => openInternalRoute(notification.extra?.url)).catch(() => undefined)

document.documentElement.style.setProperty('--df-safe-area-top', titlebarSafeArea)
document.documentElement.style.setProperty('--df-server-rail-width', serverRailWidth)
document.documentElement.style.setProperty('--df-auth-stage-width', 'calc(50vw - var(--df-server-rail-width))')

document.addEventListener('DOMContentLoaded', () => {
  const dragRegion = document.createElement('div')
  dragRegion.dataset.tauriDragRegion = ''
  dragRegion.setAttribute('aria-hidden', 'true')
  dragRegion.style.cssText = [
    'position:fixed',
    `inset:0 0 auto ${serverRailWidth}`,
    `height:${titlebarSafeArea}`,
    'z-index:2147483647',
  ].join(';')
  document.body.prepend(dragRegion)
})

function requestUrl(input: RequestInfo | URL): URL {
  const value = input instanceof Request ? input.url : input.toString()
  return new URL(value, window.location.href)
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = requestUrl(input)
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return tauriFetch(input, init)
  }
  return webFetch(input, init)
}) as typeof globalThis.fetch

document.addEventListener('click', (event) => {
  const element = event.target instanceof Element ? event.target : null
  const anchor = element?.closest('a[href]')
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '_blank') return

  const url = new URL(anchor.href, window.location.href)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  event.preventDefault()
  void openUrl(url.href)
})
