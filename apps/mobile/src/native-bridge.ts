import { Browser } from '@capacitor/browser'
import { LocalNotifications } from '@capacitor/local-notifications'
import { Badge } from '@capawesome/capacitor-badge'
import { keepRecordingKey } from '../../../packages/native-shell/recording-key'
import { L4Share } from './share-plugin'

// Injected by the native shell into each Server's own Client. The Client finds
// window.__LLLL_NATIVE_NOTIFICATIONS__ and uses it instead of Web Push, which
// iOS does not offer inside an app's WebView.
const notificationsKey = 'df:native-notifications-enabled'

function notificationId(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index++) hash = ((hash * 31) + value.charCodeAt(index)) | 0
  return Math.abs(hash % 2147483647) || 1
}

// Notifications store an absolute URL so a tap opens the right Server even when
// another Server is on screen.
function openNotificationUrl(value: unknown) {
  if (typeof value !== 'string') return
  let url: URL
  try { url = new URL(value) }
  catch { return }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return
  window.location.assign(url.href)
}

function serverUrl(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') ? location.origin + path : location.origin + '/'
}

if (location.protocol === 'https:' || location.protocol === 'http:') {
  window.__LLLL_NATIVE_NOTIFICATIONS__ = {
    async status() {
      const permission = await LocalNotifications.checkPermissions()
      if (permission.display === 'denied') return 'blocked'
      return permission.display === 'granted' && localStorage.getItem(notificationsKey) === 'true' ? 'subscribed' : 'prompt'
    },
    async enable() {
      const permission = await LocalNotifications.requestPermissions()
      if (permission.display !== 'granted') return 'blocked'
      localStorage.setItem(notificationsKey, 'true')
      return 'subscribed'
    },
    async disable() {
      localStorage.setItem(notificationsKey, 'false')
      await Promise.allSettled([Badge.clear(), LocalNotifications.removeAllDeliveredNotifications()])
    },
    async setBadge(count) {
      if (count > 0) await Badge.set({ count })
      else await Badge.clear()
    },
    async notify(notification) {
      if (localStorage.getItem(notificationsKey) !== 'true') return
      const permission = await LocalNotifications.checkPermissions()
      if (permission.display !== 'granted') return
      await LocalNotifications.schedule({
        notifications: [{
          id: notificationId(location.origin + notification.id),
          title: notification.title,
          body: notification.body,
          badge: notification.badge,
          threadIdentifier: location.origin,
          extra: { url: serverUrl(notification.url) },
        }],
      })
    },
  }

  document.addEventListener('click', (event) => {
    const element = event.target instanceof Element ? event.target : null
    const anchor = element?.closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '_blank') return

    const url = new URL(anchor.href, window.location.href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return

    event.preventDefault()
    void Browser.open({ url: url.href })
  })
}

void LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
  openNotificationUrl(action.notification.extra?.url)
}).catch(() => undefined)

if (location.protocol === 'https:' || location.protocol === 'http:') {
  window.__LLLL_NATIVE_SHOW_SERVERS__ = () => L4Share.showServers()
  window.__LLLL_NATIVE_RAIL__ = visible => L4Share.setRail({ visible })
  keepRecordingKey({
    serverNeedingKey: async () => {
      const { serverId } = await L4Share.serverNeedingKey()
      return serverId ? { serverId } : null
    },
    saveKey: token => L4Share.saveKey({ token }),
  }, /iPad/u.test(navigator.userAgent) ? 'iPad' : 'iPhone')
}
