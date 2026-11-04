/* global clients */
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data?.json() ?? {}
  }
  catch { /* show a generic notification below */ }
  const title = typeof payload.title === 'string' && payload.title ? payload.title.slice(0, 160) : 'L4'
  const options = {
    body: typeof payload.body === 'string' ? payload.body.slice(0, 300) : 'New activity',
    tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 180) : undefined,
    icon: '/android-chrome-192x192.png',
    badge: '/favicon-32x32.png',
    data: { url: typeof payload.url === 'string' ? payload.url : '/' },
  }
  event.waitUntil((async () => {
    if (Number.isSafeInteger(payload.badgeCount) && payload.badgeCount >= 0) {
      try {
        if (payload.badgeCount === 0) await self.navigator.clearAppBadge?.()
        else await self.navigator.setAppBadge?.(payload.badgeCount)
      } catch { /* Badge support and permission vary by browser. */ }
    }
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (windows.some(client => client.focused && client.visibilityState === 'visible')) return
    await self.registration.showNotification(title, options)
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  let target = new URL('/', self.location.origin)
  try {
    const requested = new URL(event.notification.data?.url || '/', self.location.origin)
    if (requested.origin === self.location.origin) target = requested
  }
  catch { /* retain the safe root URL */ }
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if ('navigate' in client) await client.navigate(target.href)
      return client.focus()
    }
    return clients.openWindow(target.href)
  })())
})
