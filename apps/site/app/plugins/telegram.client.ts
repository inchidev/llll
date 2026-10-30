export default defineNuxtPlugin(async () => {
  const hash = new URLSearchParams(location.hash.slice(1))
  const data = window.Telegram?.WebApp?.initData || hash.get('tgWebAppData') || ''
  useState('shell-telegram', () => data)
  if (!data) return
  history.replaceState(history.state, '', location.pathname + location.search)
  const script = document.createElement('script'); script.src = 'https://telegram.org/js/telegram-web-app.js'; document.head.appendChild(script)
  await Promise.race([new Promise<void>(resolve => {script.onload=()=>resolve();script.onerror=()=>resolve()}),new Promise<void>(resolve=>setTimeout(resolve,2000))])
  const app = window.Telegram?.WebApp
  app?.ready?.(); app?.expand?.()
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
  const start = new URLSearchParams(data).get('start_param') || ''
  if (/^server_[a-f0-9-]{36}$/.test(start)) await navigateTo('/' + start.slice(7))
  // Like the installed app, Telegram opens the Shell rather than the website.
  else if (location.pathname === '/') await navigateTo('/servers')
})
