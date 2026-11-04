// Injected by the Android app into each allowed Server's own Client. The Client
// finds window.__LLLL_NATIVE_NOTIFICATIONS__ and uses it instead of Web Push,
// which Android does not offer inside an app's WebView.
type NativeChannel = {
  postMessage: (message: string) => void
  onmessage: ((event: { data: string }) => void) | null
}

const native = (window as unknown as { l4Native?: NativeChannel }).l4Native
const notificationsKey = 'df:native-notifications-enabled'

// The app's own pages at this origin are not a Server.
if (native && location.origin !== 'https://localhost') {
  const pending = new Map<number, (result: string) => void>()
  let nextId = 1

  native.onmessage = (event) => {
    const reply = JSON.parse(event.data) as { id: number; result: string }
    pending.get(reply.id)?.(reply.result)
    pending.delete(reply.id)
  }

  const call = (method: string, details: Record<string, unknown> = {}) => new Promise<string>((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    native.postMessage(JSON.stringify({ id, method, ...details }))
  })

  window.__LLLL_NATIVE_SHOW_SERVERS__ = async () => { await call('servers') }
  window.__LLLL_NATIVE_RAIL__ = async (visible) => { await call('rail', { visible }) }

  type Status = 'prompt' | 'subscribed' | 'blocked' | 'error'

  window.__LLLL_NATIVE_NOTIFICATIONS__ = {
    async status() {
      const permission = await call('permission') as Status
      return permission === 'subscribed' && localStorage.getItem(notificationsKey) !== 'true' ? 'prompt' : permission
    },
    async enable() {
      const permission = await call('enable') as Status
      if (permission === 'subscribed') localStorage.setItem(notificationsKey, 'true')
      return permission
    },
    async disable() {
      localStorage.setItem(notificationsKey, 'false')
      await call('clear')
    },
    async setBadge(count) {
      // The launcher counts delivered notifications; reading them clears it.
      if (count === 0) await call('clear')
    },
    async notify(notification) {
      if (localStorage.getItem(notificationsKey) === 'true') await call('notify', { notification })
    },
  }

  document.addEventListener('click', (event) => {
    const element = event.target instanceof Element ? event.target : null
    const anchor = element?.closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '_blank') return

    const url = new URL(anchor.href, window.location.href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return

    event.preventDefault()
    void call('open', { url: url.href })
  })
}
