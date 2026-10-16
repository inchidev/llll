import { embedCommand, EMBED_VERSION, safeEmbedPath } from '~~/shared/embed'

export default defineNuxtPlugin(async (nuxt) => {
  if (window.parent === window) return
  const connections = useInstallations()
  const context = useState('llll-embed', () => ({ parent: '', enabled: true }))
  const parameters = new URLSearchParams(location.search)
  const parentOrigin = parameters.get('parent') || (() => { try { return sessionStorage.getItem('llll.embed-parent') || '' } catch { return '' } })()
  const installation = await connections.discover(location.origin)
  if (!installation.embedOrigins?.includes(parentOrigin)) return
  context.value.parent = parentOrigin
  try { sessionStorage.setItem('llll.embed-parent', parentOrigin) } catch { /* Storage may be partitioned or unavailable. */ }
  const post = (data: unknown) => window.parent.postMessage({ llll: EMBED_VERSION, ...data as object }, parentOrigin)
  const router = useRouter()
  const mounted = new Promise<void>(resolve => nuxt.hook('app:mounted', () => { resolve() }))
  const live = useLiveStore()
  const colorMode = useColorMode()
  const toast = useToast()
  const unread = useState('llll-embed-unread', () => 0)
  const local = computed(() => connections.installations.value.find(i => i.origin === location.origin))
  const publish = () => {
    post({ type: 'session', authenticated: Boolean(local.value?.userId) })
    post({ type: 'servers', servers: (local.value?.servers || []).filter(s => s.publicId && s.status === 'ready').map(s => ({ id: s.publicId, name: s.name, unread: s.id === connections.active.value?.serverId ? unread.value : 0 })) })
  }
  watch(() => [local.value?.userId, local.value?.servers, unread.value], publish, { deep: true })
  watch(() => live.connection, value => post({ type: 'call', active: value === 'connected' || value === 'connecting' }))
  router.afterEach(to => {
    const server = connections.activeServer.value
    if (server?.publicId && safeEmbedPath(to.fullPath)) post({ type: 'navigate', serverId: server.publicId, path: to.fullPath })
  })
  window.addEventListener('message', async event => {
    if (event.source !== window.parent || event.origin !== parentOrigin || event.data?.llll !== EMBED_VERSION) return
    const parsed = embedCommand.safeParse(event.data)
    if (!parsed.success) return
    await mounted
    const command = parsed.data
    if (command.type === 'theme') { colorMode.preference = command.theme; return }
    if (command.type === 'telegram') {
      if (!installation.telegram) return
      try { await connections.request(location.origin, '/api/auth/telegram/miniapp', { method: 'POST', body: { initData: command.initData } }); await connections.refresh(location.origin); publish() }
      catch { /* The installation's own login remains available. */ }
      return
    }
    if (!safeEmbedPath(command.path)) return
    const server = local.value?.servers.find(s => s.publicId === command.serverId)
    if (!server) { await router.replace('/connections'); return }
    if (connections.active.value?.serverId !== server.id) {
      if (live.connection === 'connected' || live.connection === 'connecting') {
        toast.add({ title: 'End the current call before switching servers', color: 'warning' })
        const current = connections.activeServer.value
        if (current?.publicId) post({ type: 'navigate', serverId: current.publicId, path: router.currentRoute.value.fullPath })
        return
      }
      connections.select(location.origin, server.id)
      // A new server gets fresh query caches, sockets and content state.
      const form = document.createElement('form')
      form.method = 'POST'; form.action = '/embed/open'; form.style.display = 'none'
      for (const [name, value] of Object.entries({ parent: parentOrigin, server: server.publicId!, path: command.path, session: connections.tokens.value[location.origin] || '' })) {
        const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.appendChild(input)
      }
      document.body.appendChild(form); form.submit()
    }
    else await router.replace(command.path)
  })
  nuxt.hook('app:mounted', async () => {
  const requested = parameters.get('server')
  if (requested && local.value?.servers.some(s => s.publicId === requested)) {
    const server = local.value.servers.find(s => s.publicId === requested)!
    connections.select(location.origin, server.id)
    const path = parameters.get('path') || '/'
    if (safeEmbedPath(path)) await router.replace(path)
  }
  post({ type: 'ready', version: EMBED_VERSION, name: installation.name })
  publish()
  })
})
