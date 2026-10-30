import { embedCommand, EMBED_VERSION, safeEmbedPath } from '~~/shared/embed'
export default defineNuxtPlugin(async (nuxt) => {
  if (window.parent === window) return
  const connection = useServers()
  const server = await connection.discover(location.origin).catch(() => null)
  if (!server) return
  const parent =
    new URLSearchParams(location.search).get('parent') ||
    (() => {
      try {
        return sessionStorage.getItem('llll.embed-parent') || ''
      } catch {
        return ''
      }
    })()
  if (!server.embedOrigins.includes(parent)) return
  useState('llll-embed', () => ({ parent: '', enabled: true })).value = {
    parent,
    enabled: true,
  }
  try {
    sessionStorage.setItem('llll.embed-parent', parent)
  } catch {
    /* In-memory embedding still works. */
  }
  const post = (data: object) =>
    window.parent.postMessage({ llll: EMBED_VERSION, ...data }, parent)
  const session = useSessionStore()
  const live = useLiveStore()
  const colorMode = useColorMode()
  const router = useRouter()
  const unread = useState('llll-embed-unread', () => 0)
  const outstandingMessages = useState('llll-outstanding-messages', () => 0)
  const publishDelivery = () => post({ type: 'delivery', pending: outstandingMessages.value > 0 })
  watch(() => outstandingMessages.value > 0, publishDelivery, { flush: 'sync' })
  const appearance = computed(() => connection.servers.value.find(item => item.origin === location.origin && item.id === server.id) || server)
  const publish = () => {
    post({ type: 'session', authenticated: Boolean(session.user) })
    post({
      type: 'servers',
      servers: [{ id: server.id, name: appearance.value.name, iconUrl: appearance.value.iconUrl ?? null, updatedAt: appearance.value.updatedAt, unread: unread.value }],
    })
  }
  watch(() => [session.user?.id, unread.value, appearance.value.name, appearance.value.iconUrl, appearance.value.updatedAt], publish)
  const telegramNotifications = useTelegramEmbed()
  telegramNotifications.value.request = () => post({ type: 'telegram-subscribe', serverId: server.id })
  const ui = useUiStore()
  const publishDrawer = () => post({ type: 'drawer', open: ui.mobilePane === 'channels' })
  watch(() => ui.mobilePane === 'channels', publishDrawer)
  watch(
    () => live.connection,
    (v) =>
      post({ type: 'call', active: v === 'connected' || v === 'connecting' || v === 'reconnecting' }),
  )
  router.afterEach((to) => {
    if (safeEmbedPath(to.fullPath))
      post({ type: 'navigate', serverId: server.id, path: to.fullPath })
  })
  window.addEventListener('message', async (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== parent ||
      event.data?.llll !== EMBED_VERSION
    )
      return
    const parsed = embedCommand.safeParse(event.data)
    if (!parsed.success) return
    const command = parsed.data
    if (command.type === 'theme') {
      colorMode.preference = command.theme
      return
    }
    if (command.type === 'telegram-notifications') {
      telegramNotifications.value.available = command.available
      return
    }
    if (command.type === 'telegram-relay' || command.type === 'telegram-relay-error') {
      telegramNotifications.value.reply = command.type === 'telegram-relay'
        ? { token: command.token, relayOrigin: command.relayOrigin }
        : { error: command.message }
      return
    }
    if (command.type === 'telegram') {
      if (!server.telegram) return
      try {
        await connection.request(
          location.origin,
          '/api/auth/telegram/miniapp',
          { method: 'POST', body: { initData: command.initData } },
        )
        await session.refresh()
        publish()
      } catch {
        /* Local login remains available. */
      }
      return
    }
    if (command.serverId !== server.id || !safeEmbedPath(command.path)) {
      post({
        type: 'open-rejected',
        serverId: command.serverId,
        reason: 'unavailable',
      })
      return
    }
    await router.replace(command.path)
  })
  nuxt.hook('app:mounted', () => {
    post({ type: 'ready', version: EMBED_VERSION, name: server.name })
    publishDelivery()
    publishDrawer()
    publish()
  })
})
