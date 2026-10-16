export default defineNuxtPlugin(async () => {
  const connections = useInstallations()
  const clientMode = useRuntimeConfig().public.clientMode as string
  connections.initialize()
  if (['http:', 'https:'].includes(location.protocol)) {
    try {
      const discovery = await connections.discover(location.origin)
      if (discovery.kind === 'server' && !connections.active.value) connections.select(location.origin, discovery.id)
      const launch = useState<string>('llll-telegram-launch', () => '')
      if (discovery.kind === 'installation' && discovery.telegram && launch.value) {
        const initData = launch.value
        launch.value = ''
        await connections.request(location.origin, '/api/auth/telegram/miniapp', { method: 'POST', body: { initData } })
      }
    }
    catch { /* The client can always add an installation explicitly. */ }
  }
  await Promise.all(connections.installations.value.map(async installation => {
    try { await connections.refresh(installation.origin) }
    catch { /* Keep unavailable connections visible for account recovery. */ }
  }))
  const original = globalThis.$fetch
  globalThis.$fetch = original.create({
    onRequest({ request, options }) {
      if (typeof request !== 'string' || !request.startsWith('/api/') || !connections.activeBase.value) return
      options.baseURL = connections.activeBase.value
      options.credentials = 'include'
      const headers = new Headers(options.headers)
      const token = connections.tokens.value[connections.active.value?.origin || '']
      if (token) headers.set('Authorization', `Bearer ${token}`)
      headers.set('x-llll-client', clientMode)
      options.headers = headers
    },
  })
  const timer = setInterval(() => {
    if (document.hidden) return
    for (const installation of connections.installations.value) void connections.refresh(installation.origin).catch(() => {})
  }, 120000)
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
})
