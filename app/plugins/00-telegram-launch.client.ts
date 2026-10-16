type TelegramApp = { initData?: string; ready?: () => void; expand?: () => void; safeAreaInset?: { top?: number; bottom?: number }; contentSafeAreaInset?: { top?: number; bottom?: number }; onEvent?: (name: string, callback: () => void) => void }
type TelegramWindow = Window & { Telegram?: { WebApp?: TelegramApp } }

export default defineNuxtPlugin({
  name: 'telegram-launch', order: -30,
  async setup() {
    const target = window as TelegramWindow
    const params = new URLSearchParams(location.hash.slice(1))
    const initData = target.Telegram?.WebApp?.initData || params.get('tgWebAppData') || ''
    useState('llll-telegram-launch', () => initData)
    if (!initData) return
    const start = new URLSearchParams(initData).get('start_param') || ''
    const invite = /^invite_([a-f0-9]{64})$/.exec(start)?.[1]
    const query = new URLSearchParams(location.search)
    if (invite) query.set('invite', invite)
    const ui = new URLSearchParams()
    for (const key of ['tgWebAppVersion', 'tgWebAppPlatform', 'tgWebAppThemeParams']) { const value = params.get(key); if (value) ui.set(key, value) }
    history.replaceState(history.state, '', `/connections${query.size ? '?' + query : ''}${ui.size ? '#' + ui : ''}`)
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
