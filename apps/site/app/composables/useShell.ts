import { normalizeServerOrigin } from '../../../../shared/client-router'
import { embedEvent, EMBED_VERSION, safeEmbedPath } from '../../../../shared/embed'

export type ShellServer = { id: string; name: string; unread: number }
export type ShellInstallation = { origin: string; name: string; collapsed: boolean; servers: ShellServer[] }

/** The well-known check failing at the network level names itself: navigation to
 * the shell must say what stalled instead of silently showing an empty form. */
export const INSTALLATION_UNREACHABLE = 'The installation is unreachable. Check the address or try again in a moment.'

export function useShell() {
  const installations = useState<ShellInstallation[]>('shell-installations', () => [])
  const selected = useState('shell-selected', () => '')
  const loaded = useState<string[]>('shell-loaded', () => [])
  const calls = useState<Record<string, boolean>>('shell-calls', () => ({}))
  const initialized = useState('shell-initialized', () => false)
  const frames = useState<Record<string, HTMLIFrameElement>>('shell-frames', () => ({}))
  const pending = useState<Record<string, string>>('shell-pending-server', () => ({}))
  const error = useState('shell-error', () => '')
  const registered = new Set<string>()
  const pendingClaims: Record<string, string> = {}
  const telegram = useState<string>('shell-telegram', () => '')
  const route = useRoute()
  const router = useRouter()

  function persist() {
    try { localStorage.setItem('llll.shell.v1', JSON.stringify(installations.value)) } catch { /* Bookmarks remain usable in memory. */ }
  }
  function send(origin: string, data: object) {
    frames.value[origin]?.contentWindow?.postMessage({ llll: EMBED_VERSION, ...data }, origin)
  }
  function requestedPath() {
    const path = route.params.serverId ? route.fullPath.slice(String(route.params.serverId).length + 1) || '/' : '/'
    return safeEmbedPath(path) ? path : '/'
  }
  function open(installation: ShellInstallation, serverId?: string) {
    selected.value = installation.origin
    if (!loaded.value.includes(installation.origin)) loaded.value.push(installation.origin)
    if (serverId) {
      pending.value[installation.origin] = serverId
      void router.push('/' + serverId)
      send(installation.origin, { type: 'open', serverId, path: '/' })
    }
  }
  async function connect(address: string, claim?: string) {
    const url = new URL(/^https?:\/\//.test(address) ? address : 'https://' + address)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Enter an HTTPS installation address')
    const validClaim = /^[A-Za-z0-9_-]{20,300}$/.test(claim || '') ? claim : undefined
    if (validClaim) pendingClaims[url.origin] = validClaim
    let response: Response
    try { response = await fetch(url.origin + '/.well-known/llll', { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) }) }
    catch { throw new Error(INSTALLATION_UNREACHABLE) }
    const data = await response.json()
    if (!response.ok || data.product !== 'llll' || data.kind !== 'installation' || data.origin !== url.origin) throw new Error('This address is not an L4 installation')
    if (!data.embedOrigins?.includes(location.origin)) throw new Error('This installation has not allowed embedding here. Open its own address or ask its operator.')
    let installation = installations.value.find(item => item.origin === url.origin)
    if (!installation) { installation = { origin: url.origin, name: String(data.name).slice(0, 100), collapsed: false, servers: [] }; installations.value.push(installation) }
    persist(); open(installation)
    return installation
  }
  function frameSrc(origin: string, parentOrigin: string) {
    const claim = pendingClaims[origin]
    return `${origin}/connections?parent=${encodeURIComponent(parentOrigin)}${claim ? `#claim=${claim}` : ''}`
  }
  async function resolveServer() {
    const id = String(route.params.serverId || '')
    if (!id) return
    let installation = installations.value.find(i => i.servers.some(s => s.id === id))
    if (!installation) {
      const resolved = await $fetch<{ origin: string }>('/api/servers/' + encodeURIComponent(id))
      installation = await connect(resolved.origin)
    }
    selected.value = installation.origin
    if (!loaded.value.includes(installation.origin)) loaded.value.push(installation.origin)
    pending.value[installation.origin] = id
    send(installation.origin, { type: 'open', serverId: id, path: requestedPath() })
  }
  function initialize() {
    if (initialized.value) return
    initialized.value = true
    try {
      const saved = JSON.parse(localStorage.getItem('llll.shell.v1') || '[]')
      if (Array.isArray(saved)) installations.value = saved.slice(0, 50).flatMap(i => {
        try {
          const origin = normalizeServerOrigin(i.origin)
          const parsed = embedEvent.parse({ type: 'servers', servers: i.servers })
          if (parsed.type !== 'servers') return []
          return [{ origin, name: String(i.name).slice(0, 100), collapsed: Boolean(i.collapsed), servers: parsed.servers }]
        } catch { return [] }
      })
    } catch { /* Start with an empty rail. */ }
    window.addEventListener('message', event => {
      const installation = installations.value.find(i => i.origin === event.origin)
      if (!installation || event.source !== frames.value[event.origin]?.contentWindow || event.data?.llll !== EMBED_VERSION) return
      const parsed = embedEvent.safeParse(event.data)
      if (!parsed.success) return
      const message = parsed.data
      if (message.type === 'ready') {
        send(event.origin, { type: 'theme', theme: 'dark' })
        if (event.origin === selected.value && route.params.serverId) send(event.origin, { type: 'open', serverId: route.params.serverId, path: requestedPath() })
        const initData = telegram.value || window.Telegram?.WebApp?.initData
        if (event.origin === selected.value && initData) send(event.origin, { type: 'telegram', initData })
      }
      if (message.type === 'servers') {
        installation.servers = message.servers
        persist()
        for (const server of message.servers) {
          const key = event.origin + '/' + server.id
          if (registered.has(key)) continue
          registered.add(key)
          void $fetch('/api/servers/register', { method: 'POST', body: { origin: event.origin, id: server.id } }).catch(() => { registered.delete(key) })
        }
        if (event.origin === selected.value && route.params.serverId && message.servers.some(s => s.id === route.params.serverId)) send(event.origin, { type: 'open', serverId: route.params.serverId, path: requestedPath() })
      }
      if (message.type === 'session' && !message.authenticated) { installation.servers = []; persist() }
      if (message.type === 'navigate' && event.origin === selected.value && installation.servers.some(s => s.id === message.serverId) && safeEmbedPath(message.path)) {
        if (pending.value[event.origin] && pending.value[event.origin] !== message.serverId) return
        Reflect.deleteProperty(pending.value, event.origin)
        void router.replace('/' + message.serverId + (message.path === '/' ? '' : message.path))
      }
      if (message.type === 'open-rejected' && pending.value[event.origin] === message.serverId) {
        Reflect.deleteProperty(pending.value, event.origin)
        error.value = message.reason === 'call-active' ? 'End the current call before switching servers.' : 'This server is unavailable on the installation.'
        if (event.origin === selected.value && message.currentServerId && installation.servers.some(s => s.id === message.currentServerId) && message.path && safeEmbedPath(message.path)) void router.replace('/' + message.currentServerId + message.path)
      }
      if (message.type === 'call') calls.value[event.origin] = message.active
    })
  }
  function forget(origin: string) {
    if (calls.value[origin]) throw new Error('End the active call before removing this installation')
    installations.value = installations.value.filter(i => i.origin !== origin)
    loaded.value = loaded.value.filter(i => i !== origin)
    Reflect.deleteProperty(frames.value, origin)
    if (selected.value === origin) selected.value = ''
    persist()
  }
  return { error, installations, selected, loaded, calls, frames, frameSrc, initialize, connect, open, resolveServer, persist, forget }
}
