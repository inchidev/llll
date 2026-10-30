type Insets = { top?: number; bottom?: number }
type TelegramApp = {
  initData?: string; platform?: string; ready?: () => void; expand?: () => void
  isVersionAtLeast?: (version: string) => boolean; requestFullscreen?: () => void; disableVerticalSwipes?: () => void
  setHeaderColor?: (color: string) => void; setBackgroundColor?: (color: string) => void; setBottomBarColor?: (color: string) => void
  requestWriteAccess?: (callback?: (granted: boolean) => void) => void
  BackButton?: { show?: () => void; onClick?: (callback: () => void) => void }
  safeAreaInset?: Insets; contentSafeAreaInset?: Insets; onEvent?: (name: string, callback: () => void) => void
}
type TelegramWindow = Window & { Telegram?: { WebApp?: TelegramApp } }

const SHELL_KEY = 'llll.telegram-shell'

/** The official Shell that handed this Server the Mini App; kept for the session so Back still works after a reload. */
function shellOrigin(params: URLSearchParams) {
  let value = params.get('llll_shell') || ''
  if (!value) try { value = sessionStorage.getItem(SHELL_KEY) || '' } catch { /* Optional browser storage. */ }
  try {
    const url = new URL(value)
    if (url.origin !== value || !(url.protocol === 'https:' || url.hostname === 'localhost')) return ''
    try { sessionStorage.setItem(SHELL_KEY, value) } catch { /* Optional browser storage. */ }
    return value
  } catch { return '' }
}

export default defineNuxtPlugin({
  name: 'telegram-launch', order: -30,
  async setup() {
    const target = window as TelegramWindow
    const params = new URLSearchParams(location.hash.slice(1))
    const initData = target.Telegram?.WebApp?.initData || params.get('tgWebAppData') || ''
    useState('llll-telegram-launch', () => initData)
    if (!initData) return
    const shell = shellOrigin(params)
    const start = new URLSearchParams(initData).get('start_param') || ''
    const invite = /^invite_([a-f0-9]{64})$/.exec(start)?.[1]
    const query = new URLSearchParams(location.search)
    if (invite) query.set('invite', invite)
    const ui = new URLSearchParams()
    for (const key of ['tgWebAppVersion', 'tgWebAppPlatform', 'tgWebAppThemeParams']) { const value = params.get(key); if (value) ui.set(key, value) }
    // The Shell opens a Server at the page someone asked for; the Server's own Mini App starts at sign-in.
    const path = shell && !invite ? location.pathname : '/connections'
    history.replaceState(history.state, '', `${path}${query.size ? '?' + query : ''}${ui.size ? '#' + ui : ''}`)
    if (!target.Telegram?.WebApp) {
      try { sessionStorage.removeItem('__telegram__initParams') }
      catch { /* SDK identity persistence is optional browser storage. */ }
      const script = document.createElement('script')
      script.src = 'https://telegram.org/js/telegram-web-app.js'
      document.head.appendChild(script)
      await Promise.race([new Promise<void>(resolve => { script.onload = () => resolve(); script.onerror = () => resolve() }), new Promise<void>(resolve => setTimeout(resolve, 2000))])
    }
    history.replaceState(history.state, '', location.pathname + location.search)
    const app = target.Telegram?.WebApp
    app?.ready?.()
    app?.expand?.()
    if (shell) {
      // Same frame as the Shell it came from: full screen on phones, black around it, Back to My Servers.
      if (['ios', 'android'].includes(app?.platform || '') && app?.isVersionAtLeast?.('8.0')) app.requestFullscreen?.()
      if (app?.isVersionAtLeast?.('7.7')) app.disableVerticalSwipes?.()
      app?.setHeaderColor?.('#000000'); app?.setBackgroundColor?.('#000000')
      if (app?.isVersionAtLeast?.('7.10')) app.setBottomBarColor?.('#000000')
      app?.BackButton?.onClick?.(() => location.assign(shell + '/servers'))
      app?.BackButton?.show?.()
      offerNotifications(app, initData, shell)
    }
    function safeAreas() {
      for (const edge of ['top', 'bottom'] as const) {
        const size = Math.max(0, app?.safeAreaInset?.[edge] || 0) + Math.max(0, app?.contentSafeAreaInset?.[edge] || 0)
        document.documentElement.style.setProperty(`--df-safe-area-${edge}`, `max(env(safe-area-inset-${edge}, 0px), ${size}px)`)
      }
    }
    safeAreas()
    app?.onEvent?.('safeAreaChanged', safeAreas)
    app?.onEvent?.('contentSafeAreaChanged', safeAreas)
    app?.onEvent?.('viewportChanged', safeAreas)
  },
})

/** Without a Shell around it, this Server asks Telegram and the Shell's relay itself. */
function offerNotifications(app: TelegramApp | undefined, initData: string, shell: string) {
  const telegram = useTelegramEmbed()
  telegram.value.available = true
  telegram.value.request = () => void (async () => {
    try {
      const granted = await new Promise<boolean>((resolve) => {
        if (!app?.requestWriteAccess || app.isVersionAtLeast?.('6.9') === false) return resolve(true)
        app.requestWriteAccess(resolve)
      })
      if (!granted) throw new Error('Allow L4 to message you in Telegram to get notifications there')
      const { id: serverId } = await (await fetch('/.well-known/llll')).json() as { id: string }
      const response = await fetch(shell + '/api/telegram/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, serverId }) })
      const body = await response.json().catch(() => null) as { token?: string; error?: { message?: string } } | null
      if (!response.ok || !body?.token) throw new Error(body?.error?.message || 'Telegram notifications could not be enabled')
      telegram.value.reply = { token: body.token, relayOrigin: shell }
    }
    catch (cause) {
      telegram.value.reply = { error: (cause instanceof Error ? cause.message : '') || 'Telegram notifications could not be enabled' }
    }
  })()
}
