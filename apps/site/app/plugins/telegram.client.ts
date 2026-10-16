export default defineNuxtPlugin(async () => {
  const hash = new URLSearchParams(location.hash.slice(1))
  const data = window.Telegram?.WebApp?.initData || hash.get('tgWebAppData') || ''
  useState('shell-telegram', () => data)
  if (!data) return
  history.replaceState(history.state, '', location.pathname + location.search)
  const script = document.createElement('script'); script.src = 'https://telegram.org/js/telegram-web-app.js'; document.head.appendChild(script)
  await Promise.race([new Promise<void>(resolve => {script.onload=()=>resolve();script.onerror=()=>resolve()}),new Promise<void>(resolve=>setTimeout(resolve,2000))])
  window.Telegram?.WebApp?.ready?.(); window.Telegram?.WebApp?.expand?.()
  const start = new URLSearchParams(data).get('start_param') || ''
  if (/^server_[a-f0-9-]{36}$/.test(start)) await navigateTo('/' + start.slice(7))
})