export {}

const notificationsKey = 'df:extension-notifications-enabled'
const notificationRoutePrefix = 'df:notification-route:'

function originPattern(origin: string): string {
  const url = new URL(origin)
  return `${url.protocol}//${url.host}/*`
}

window.__LLLL_EXTENSION__ = {
  async requestServerAccess(origin) {
    const origins = [originPattern(origin)]
    if (await chrome.permissions.contains({ origins })) return true
    return await chrome.permissions.request({ origins })
  },
}

window.__LLLL_NATIVE_NOTIFICATIONS__ = {
  async status() {
    return localStorage.getItem(notificationsKey) === 'true' ? 'subscribed' : 'prompt'
  },
  async enable() {
    localStorage.setItem(notificationsKey, 'true')
    return 'subscribed'
  },
  async disable() {
    localStorage.setItem(notificationsKey, 'false')
    const notifications = await chrome.notifications.getAll()
    await Promise.all(Object.keys(notifications).map(id => chrome.notifications.clear(id)))
    await chrome.action.setBadgeText({ text: '' })
  },
  async setBadge(count) {
    await Promise.all([
      chrome.action.setBadgeBackgroundColor({ color: '#f6821f' }),
      chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : '' }),
    ])
  },
  async notify(notification) {
    if (localStorage.getItem(notificationsKey) !== 'true') return
    await chrome.storage.local.set({ [`${notificationRoutePrefix}${notification.id}`]: notification.url })
    await chrome.notifications.create(notification.id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('brand/logo-128.png'),
      title: notification.title,
      message: notification.body,
    })
  },
}

document.documentElement.style.setProperty('--df-server-rail-width', '3.5rem')

document.addEventListener('click', (event) => {
  const element = event.target instanceof Element ? event.target : null
  const anchor = element?.closest('a[href]')
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '_blank') return

  const url = new URL(anchor.href, window.location.href)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  event.preventDefault()
  void chrome.tabs.create({ url: url.href })
})
