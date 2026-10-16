import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { LocalNotifications } from '@capacitor/local-notifications'
import { Badge } from '@capawesome/capacitor-badge'

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
        id: notificationId(notification.id),
        title: notification.title,
        body: notification.body,
        badge: notification.badge,
        threadIdentifier: 'messages',
        extra: { url: notification.url },
        foreground: false,
      }],
    })
  },
}

void LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
  openInternalRoute(action.notification.extra?.url)
}).catch(() => undefined)

document.addEventListener('click', (event) => {
  const element = event.target instanceof Element ? event.target : null
  const anchor = element?.closest('a[href]')
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '_blank') return

  const url = new URL(anchor.href, window.location.href)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  event.preventDefault()
  void Browser.open({ url: url.href })
})

window.__LLLL_OPEN_AUTH__ = async (url) => { await Browser.open({ url }) }
function acceptConnectionUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'llll:' || url.hostname !== 'connections' || !url.hash.includes('llll_connection=')) return
  void Browser.close().catch(() => undefined)
  window.location.assign(`/connections${url.hash}`)
}
void App.addListener('appUrlOpen', ({ url }) => acceptConnectionUrl(url))
void App.getLaunchUrl().then(value => { if (value?.url) acceptConnectionUrl(value.url) })
