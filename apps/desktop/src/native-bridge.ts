import { getCurrentWindow } from '@tauri-apps/api/window'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { openUrl } from '@tauri-apps/plugin-opener'
import { invoke } from '@tauri-apps/api/core'
import { keepRecordingKey } from '../../../packages/native-shell/recording-key'

// Injected by the native shell into each Server's own Client. The Client finds
// window.__LLLL_NATIVE_NOTIFICATIONS__ and uses it instead of Web Push.
const titlebarSafeArea = '2.25rem'
const notificationsKey = 'df:native-notifications-enabled'

function notificationId(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index++) hash = ((hash * 31) + value.charCodeAt(index)) | 0
  return Math.abs(hash % 2147483647) || 1
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

function addTitlebar() {
  const titlebar = document.createElement('div')
  titlebar.dataset.tauriDragRegion = ''
  titlebar.style.cssText = `position:fixed;inset:0 0 auto 0;height:${titlebarSafeArea};z-index:2147483647`
  document.body.prepend(titlebar)
}

if (location.protocol === 'https:' || location.protocol === 'http:') {
  window.__LLLL_NATIVE_SHOW_SERVERS__ = async () => window.location.assign('tauri://localhost/index.html#servers')
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
        id: notificationId(location.origin + notification.id),
        title: notification.title,
        body: notification.body,
        group: location.origin,
      })
    },
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--df-safe-area-top', titlebarSafeArea)
    addTitlebar()
  })

  document.addEventListener('click', (event) => {
    const element = event.target instanceof Element ? event.target : null
    const anchor = element?.closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '_blank') return

    const url = new URL(anchor.href, window.location.href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return

    event.preventDefault()
    void openUrl(url.href)
  })
}

if (location.protocol === 'https:' || location.protocol === 'http:') {
  keepRecordingKey({
    serverNeedingKey: async () => {
      const serverId = await invoke<string | null>('server_needing_key')
      return serverId ? { serverId } : null
    },
    saveKey: token => invoke('save_recording_key', { token }),
  }, 'Mac')
}
