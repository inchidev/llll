import { normalizeServerOrigin } from '../../../../shared/client-router'
import {
  embedEvent,
  EMBED_VERSION,
  safeEmbedPath,
  uuidSchema,
} from '../../../../shared/embed'
import { SERVER_API_VERSION } from '../../../../shared/server'
import type { ServerDiscovery } from '../../../../shared/server'
import { readDeploymentClaim, stripDeploymentClaim } from '../../../../shared/deploy-handoff'
import { serverAppearance, type ServerAppearance } from '../../../../shared/server-appearance'
import { serverDiscovery } from '../../../../shared/server-discovery'
import { readDeployedServers, recordDeployedServer } from '../../../../shared/deploy-recall'
export type ShellServer = {
  id: string
  origin: string
  name: string
  unread: number
  iconUrl?: string | null
  updatedAt?: string
}
export const SERVER_UNREACHABLE =
  'The server is unreachable. Check the address or try again in a moment.'
export function useShell() {
  const servers = useState<ShellServer[]>('shell-servers', () => [])
  const metadata = useState<Record<string, ServerAppearance>>('shell-metadata', () => ({}))
  const checked = useState<Record<string, number>>('shell-metadata-checked', () => ({}))
  const checking = useState<Record<string, boolean>>('shell-metadata-checking', () => ({}))
  const groups = computed(() =>
    servers.value.map((s) => ({
      origin: s.origin,
      name: s.name,
      servers: [s],
    })),
  )
  const selected = useState('shell-selected', () => '')
  const loaded = useState<string[]>('shell-loaded', () => [])
  const ready = useState<Record<string, boolean>>('shell-ready', () => ({}))
  const calls = useState<Record<string, boolean>>('shell-calls', () => ({}))
  const initialized = useState('shell-initialized', () => false)
  const frames = useState<Record<string, HTMLIFrameElement>>(
    'shell-frames',
    () => ({}),
  )
  const starts = useState<Record<string, string>>('shell-starts', () => ({}))
  const claims = useState<Record<string, string>>('shell-claims', () => ({}))
  const error = useState('shell-error', () => '')
  const address = useState('shell-address', () => '')
  const busy = useState('shell-busy', () => false)
  const telegram = useState<string>('shell-telegram', () => '')
  const route = useRoute()
  const router = useRouter()
  function persist() {
    try {
      localStorage.setItem(
        'llll.shell.servers.v1',
        JSON.stringify(servers.value),
      )
    } catch {
      /* Bookmarks remain usable in memory. */
    }
  }
  function updateMetadata(origin: string, value: unknown) {
    const data = serverAppearance(value, origin)
    const saved = servers.value.find(item => item.origin === origin)
    if (saved && saved.id !== data.id) return false
    const previous = metadata.value[origin]
    if (previous?.id === data.id && previous.updatedAt && (!data.updatedAt || data.updatedAt < previous.updatedAt)) return true
    metadata.value[origin] = { ...(previous?.id === data.id ? previous : {}), ...data }
    if (saved) { Object.assign(saved, metadata.value[origin]); persist() }
    const deployed = readDeployedServers().find(item => item.origin === origin)
    if (deployed && (!deployed.id || deployed.id === data.id)) recordDeployedServer({ ...deployed, ...metadata.value[origin] })
    return true
  }
  async function readMetadata(origin: string, signal = AbortSignal.timeout(7000)) {
    const response = await fetch(origin + '/.well-known/llll', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal })
    if (!response.ok) throw new Error('Server is unavailable')
    const data = serverDiscovery(await response.json(), origin)
    if (!updateMetadata(origin, data)) throw new Error('Server identity did not match the saved connection')
    return data
  }
  async function refreshMetadata() {
    let cursor = 0
    const origins = servers.value.map(item => item.origin)
    await Promise.all(Array.from({ length: Math.min(4, origins.length) }, async () => {
      while (cursor < origins.length) {
        const origin = origins[cursor++]!
        if (checking.value[origin] || Date.now() - (checked.value[origin] || 0) < 30_000) continue
        checking.value[origin] = true
        try { await readMetadata(origin) } catch { /* Keep the saved identity and appearance while offline. */ }
        finally { checked.value[origin] = Date.now(); checking.value[origin] = false }
      }
    }))
  }
  function send(origin: string, data: object) {
    if (!ready.value[origin]) return
    frames.value[origin]?.contentWindow?.postMessage(
      { llll: EMBED_VERSION, ...data },
      origin,
    )
  }
  function requestedPath() {
    const path = route.params.serverId
      ? route.fullPath.slice(String(route.params.serverId).length + 1) || '/'
      : '/'
    return safeEmbedPath(path) ? stripDeploymentClaim(path) : '/'
  }
  async function restoreClaim(origin: string, explicit?: string) {
    let claim = explicit && readDeploymentClaim('#' + new URLSearchParams({ claim: explicit }))
    if (!claim && claims.value[origin]) return
    if (!claim) {
      try {
        const state = await $fetch<{ completed?: boolean; origin?: string; claim?: string; deployments?: { origin: string; claim: string }[] }>('/api/deploy/session')
        const credential = state.completed && state.origin === origin ? state.claim : state.deployments?.find(item => item.origin === origin)?.claim
        if (credential) {
          const setup = new URL(credential)
          if (setup.origin === origin && setup.pathname === '/setup')
            claim = readDeploymentClaim(setup.hash)
        }
      } catch {
        /* A normal connection requires local login. */
      }
    }
    if (claim && claim !== claims.value[origin]) {
      claims.value[origin] = claim
      // Changing the iframe URL starts a new Client. Do not navigate it before
      // its setup page has consumed the fragment and published readiness.
      ready.value[origin] = false
    }
  }
  function open(server: ShellServer, id = server.id, path = '/') {
    if (id !== server.id) return
    selected.value = server.origin
    if (!loaded.value.includes(server.origin)) loaded.value.push(server.origin)
    void router.push('/' + server.id + (path === '/' ? '' : path))
    send(server.origin, { type: 'open', serverId: server.id, path })
  }
  async function connect(address: string, claim?: string) {
    const url = new URL(
      /^https?:\/\//.test(address) ? address : 'https://' + address,
    )
    const origin = normalizeServerOrigin(url.origin)
    if (
      url.username ||
      url.password ||
      !/^\/(?:invite\/[a-zA-Z0-9_-]+\/?)?$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error('Enter a Server address or invitation URL')
    let response: Response
    try {
      response = await fetch(origin + '/.well-known/llll', {
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new Error(SERVER_UNREACHABLE)
    }
    const d = (await response.json()) as ServerDiscovery
    const aliases = Array.isArray(d.aliases) ? d.aliases.filter((item): item is string => typeof item === 'string') : []
    if (
      !response.ok ||
      d.product !== 'llll' ||
      d.kind !== 'server' ||
      d.apiVersion !== SERVER_API_VERSION ||
      (d.origin !== origin && !aliases.includes(origin)) ||
      !uuidSchema.safeParse(d.id).success
    )
      throw new Error('This address is not a compatible L4 Server')
    if (!d.embedOrigins?.includes(location.origin))
      throw new Error(
        'This Server has not allowed embedding here. Open its own address or ask its operator.',
      )
    let server = servers.value.find((s) => s.origin === origin)
    if (server && server.id !== d.id)
      throw new Error(
        'The Server identity at this address changed. Remove the old connection before reconnecting.',
      )
    if (!server) {
      server = servers.value.find((s) => s.id === d.id)
    }
    if (!server) {
      server = {
        origin,
        id: d.id,
        name: String(d.name).slice(0, 100),
        unread: 0,
      }
      servers.value.push(server)
    }
    if (server.origin === origin) updateMetadata(origin, d)
    const targetOrigin = server.origin
    if (claim || !loaded.value.includes(targetOrigin)) await restoreClaim(targetOrigin, claim)
    if (claims.value[targetOrigin]) starts.value[targetOrigin] = '/setup'
    else if (!loaded.value.includes(targetOrigin)) {
      starts.value[targetOrigin] = url.pathname.startsWith('/invite/')
        ? url.pathname
        : d.ready
          ? '/'
          : '/setup'
    }
    persist()
    open(server, server.id, starts.value[targetOrigin] || '/')
    return server
  }
  function frameSrc(origin: string, parent: string) {
    const target = new URL(starts.value[origin] || '/', origin)
    target.searchParams.set('parent', parent)
    if (claims.value[origin]) target.hash = 'claim=' + claims.value[origin]
    return target.toString()
  }
  async function submitAddress() {
    error.value = ''
    busy.value = true
    try {
      await connect(address.value)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Could not connect'
    } finally {
      busy.value = false
    }
  }
  async function resolveServer() {
    const id = String(route.params.serverId || '')
    if (!uuidSchema.safeParse(id).success) return
    const path = requestedPath()
    const claim = readDeploymentClaim(route.hash)
    let server = servers.value.find((s) => s.id === id)
    if (!server) {
      const resolved = await $fetch<{ origin: string }>(
        '/api/servers/' + encodeURIComponent(id),
      )
      server = await connect(resolved.origin, claim)
      if (server.id !== id)
        throw new Error('Server identity did not match the link')
    }
    if (/^\/setup(?:\/|\?|#|$)/.test(path)) await restoreClaim(server.origin, claim)
    selected.value = server.origin
    if (!loaded.value.includes(server.origin) || (claims.value[server.origin] && !ready.value[server.origin]))
      starts.value[server.origin] = path
    await router.replace('/' + id + (path === '/' ? '' : path))
    if (!loaded.value.includes(server.origin)) {
      loaded.value.push(server.origin)
    }
    send(server.origin, { type: 'open', serverId: id, path })
  }
  function initialize() {
    if (initialized.value) return
    initialized.value = true
    try {
      const saved = JSON.parse(
        localStorage.getItem('llll.shell.servers.v1') || '[]',
      )
      if (Array.isArray(saved))
        servers.value = saved.slice(0, 50).flatMap((s) => {
          try {
            return uuidSchema.safeParse(s.id).success
              ? [
                  {
                    origin: normalizeServerOrigin(s.origin),
                    unread: 0,
                    ...serverAppearance(s, normalizeServerOrigin(s.origin)),
                  },
                ]
              : []
          } catch {
            return []
          }
        })
      for (const saved of servers.value) updateMetadata(saved.origin, saved)
      for (const deployed of readDeployedServers()) if (deployed.id) updateMetadata(deployed.origin, deployed)
    } catch {
      /* Empty bookmarks. */
    }
    window.addEventListener('message', (event) => {
      const server = servers.value.find((s) => s.origin === event.origin)
      if (
        !server ||
        event.source !== frames.value[event.origin]?.contentWindow ||
        event.data?.llll !== EMBED_VERSION
      )
        return
      const parsed = embedEvent.safeParse(event.data)
      if (!parsed.success) return
      const m = parsed.data
      if (m.type === 'ready') {
        ready.value[server.origin] = true
        send(server.origin, { type: 'theme', theme: 'dark' })
        if (
          server.origin === selected.value &&
          route.params.serverId === server.id &&
          requestedPath() !== stripDeploymentClaim(starts.value[server.origin] || '/')
        )
          send(server.origin, {
            type: 'open',
            serverId: server.id,
            path: requestedPath(),
          })
        const initData = telegram.value || window.Telegram?.WebApp?.initData
        if (server.origin === selected.value && initData)
          send(server.origin, { type: 'telegram', initData })
      }
      if (m.type === 'servers') {
        const info = m.servers.find((s) => s.id === server.id)
        if (info) {
          if (!updateMetadata(server.origin, info)) return
          server.unread = info.unread
          persist()
          void $fetch('/api/servers/register', {
            method: 'POST',
            body: { origin: server.origin, id: server.id },
          }).catch(() => {})
        }
      }
      if (
        m.type === 'navigate' &&
        server.origin === selected.value &&
        route.params.serverId === server.id &&
        m.serverId === server.id &&
        safeEmbedPath(m.path)
      )
        void router.replace('/' + server.id + (m.path === '/' ? '' : stripDeploymentClaim(m.path)))
      if (m.type === 'session' && !m.authenticated) {
        server.unread = 0
        persist()
      }
      if (m.type === 'call') calls.value[server.origin] = m.active
    })
  }
  function forget(origin: string) {
    if (calls.value[origin])
      throw new Error('End the active call before removing this Server')
    servers.value = servers.value.filter((s) => s.origin !== origin)
    loaded.value = loaded.value.filter((s) => s !== origin)
    Reflect.deleteProperty(frames.value, origin)
    Reflect.deleteProperty(starts.value, origin)
    Reflect.deleteProperty(claims.value, origin)
    Reflect.deleteProperty(ready.value, origin)
    Reflect.deleteProperty(calls.value, origin)
    Reflect.deleteProperty(metadata.value, origin)
    if (selected.value === origin) selected.value = ''
    persist()
  }
  return {
    error,
    servers,
    metadata,
    updateMetadata,
    readMetadata,
    refreshMetadata,
    groups,
    selected,
    loaded,
    calls,
    frames,
    frameSrc,
    initialize,
    connect,
    open,
    resolveServer,
    persist,
    forget,
    address,
    busy,
    submitAddress,
  }
}
