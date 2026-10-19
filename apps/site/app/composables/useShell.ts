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
export type ShellServer = {
  id: string
  origin: string
  name: string
  unread: number
}
export const SERVER_UNREACHABLE =
  'The server is unreachable. Check the address or try again in a moment.'
export function useShell() {
  const servers = useState<ShellServer[]>('shell-servers', () => [])
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
        const state = await $fetch<{ completed?: boolean; origin?: string; claim?: string }>('/api/deploy/session')
        if (state.completed && state.origin === origin && state.claim) {
          const setup = new URL(state.claim)
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
    if (
      !response.ok ||
      d.product !== 'llll' ||
      d.kind !== 'server' ||
      d.apiVersion !== SERVER_API_VERSION ||
      d.origin !== origin ||
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
      server = {
        origin,
        id: d.id,
        name: String(d.name).slice(0, 100),
        unread: 0,
      }
      servers.value.push(server)
    }
    if (claim || !loaded.value.includes(origin)) await restoreClaim(origin, claim)
    if (claims.value[origin]) starts.value[origin] = '/setup'
    else if (!loaded.value.includes(origin)) {
      starts.value[origin] = url.pathname.startsWith('/invite/')
        ? url.pathname
        : d.ready
          ? '/'
          : '/setup'
    }
    persist()
    open(server, server.id, starts.value[origin] || '/')
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
                    id: s.id,
                    origin: normalizeServerOrigin(s.origin),
                    name: String(s.name).slice(0, 100),
                    unread: 0,
                  },
                ]
              : []
          } catch {
            return []
          }
        })
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
          route.params.serverId === server.id
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
          server.name = info.name
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
    if (selected.value === origin) selected.value = ''
    persist()
  }
  return {
    error,
    servers,
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
