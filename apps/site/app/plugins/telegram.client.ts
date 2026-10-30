export default defineNuxtPlugin(async () => {
  const hash = new URLSearchParams(location.hash.slice(1))
  const data = window.Telegram?.WebApp?.initData || hash.get('tgWebAppData') || ''
  useState('shell-telegram', () => data)
  if (!data) return
  // Telegram's SDK reads its version, platform and theme from the address; keep those, never the signed launch data.
  const ui = new URLSearchParams()
  for (const key of ['tgWebAppVersion', 'tgWebAppPlatform', 'tgWebAppThemeParams']) { const value = hash.get(key); if (value) ui.set(key, value) }
  history.replaceState(history.state, '', location.pathname + location.search + (ui.size ? '#' + ui : ''))
  if (!window.Telegram?.WebApp) {
    const script = document.createElement('script'); script.src = 'https://telegram.org/js/telegram-web-app.js'; document.head.appendChild(script)
    await Promise.race([new Promise<void>(resolve => {script.onload=()=>resolve();script.onerror=()=>resolve()}),new Promise<void>(resolve=>setTimeout(resolve,2000))])
  }
  history.replaceState(history.state, '', location.pathname + location.search)
  const app = window.Telegram?.WebApp
  app?.ready?.(); app?.expand?.()
  // On phones the Shell takes the whole screen, like the installed app; Telegram keeps its
  // controls on top, inside the safe areas below. A swipe down scrolls the chat instead of closing it.
  if (['ios', 'android'].includes(app?.platform || '') && app?.isVersionAtLeast?.('8.0')) app.requestFullscreen?.()
  if (app?.isVersionAtLeast?.('7.7')) app.disableVerticalSwipes?.()
  // Match the Shell's black frame instead of Telegram's theme colors.
  app?.setHeaderColor?.('#000000'); app?.setBackgroundColor?.('#000000')
  if (app?.isVersionAtLeast?.('7.10')) app.setBottomBarColor?.('#000000')
  // Telegram's own controls and the device's notch and home indicator. The
  // embedded Client cannot see them from its frame, so the Shell keeps clear.
  function safeAreas() {
    for (const edge of ['top', 'bottom'] as const) {
      const size = Math.max(0, app?.safeAreaInset?.[edge] || 0) + Math.max(0, app?.contentSafeAreaInset?.[edge] || 0)
      document.documentElement.style.setProperty(`--shell-safe-${edge}`, `max(env(safe-area-inset-${edge}, 0px), ${size}px)`)
    }
  }
  safeAreas()
  for (const event of ['safeAreaChanged', 'contentSafeAreaChanged', 'viewportChanged']) app?.onEvent?.(event, safeAreas)
  // The router's first navigation restores the launch address; the signed data must not stay in it.
  const router = useRouter()
  const stop = router.afterEach((to) => {
    if (!to.hash.includes('tgWebApp')) return
    stop()
    void router.replace({ path: to.path, query: to.query, hash: '' })
  })
  const start = new URLSearchParams(data).get('start_param') || ''
  if (/^server_[a-f0-9-]{36}$/.test(start)) await navigateTo('/' + start.slice(7))
  // Like the installed app, Telegram opens the Shell rather than the website.
  else if (location.pathname === '/') await navigateTo('/servers')
})
