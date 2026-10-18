import type { ConnectedInstallation, InstallationDiscovery, InstallationServer } from '~~/shared/installation'
import { INSTALLATION_API_VERSION, serverBase } from '~~/shared/installation'
import { normalizeServerOrigin } from '~~/shared/client-router'

const STORAGE = 'llll.installations.v1'
const ACTIVE = 'llll.active-server.v1'
const TOKEN = 'llll.installation-session:'

export function useInstallations() {
  const installations = useState<ConnectedInstallation[]>('llll-installations', () => [])
  const active = useState<{ origin: string; serverId: string } | null>('llll-active-server', () => null)
  const tokens = useState<Record<string, string>>('llll-installation-tokens', () => ({}))
  const initialized = useState('llll-installations-initialized', () => false)
  const activeInstallation = computed(() => installations.value.find(item => item.origin === active.value?.origin))
  const activeServer = computed(() => activeInstallation.value?.servers.find(item => item.id === active.value?.serverId))
  const activeBase = computed(() => active.value && activeInstallation.value && activeServer.value ? serverBase(active.value.origin, active.value.serverId, activeInstallation.value.kind) : null)
  const scope = computed(() => `${active.value?.origin || ''}/${active.value?.serverId || ''}/${activeInstallation.value?.userId || ''}`)

  function persist() {
    if (!import.meta.client) return
    try { localStorage.setItem(STORAGE, JSON.stringify(installations.value.map(item => ({ ...item, servers: item.servers.map(({ assetToken: _token, ...server }) => server) }))))
    localStorage.setItem(ACTIVE, JSON.stringify(active.value)) } catch { /* In-memory sessions work when embedded storage is blocked. */ }
  }

  function initialize() {
    if (!import.meta.client || initialized.value) return
    initialized.value = true
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE) || '[]')
      if (Array.isArray(saved)) installations.value = saved.flatMap((value) => {
        if (!value || typeof value !== 'object' || typeof value.origin !== 'string' || typeof value.name !== 'string' || !Array.isArray(value.servers)) return []
        try {
          const origin = normalizeServerOrigin(value.origin)
          const token = sessionStorage.getItem(`${TOKEN}${origin}`)
          if (token) tokens.value[origin] = token
          return [{ origin, id: String(value.id || origin), name: value.name.slice(0, 100), kind: value.kind === 'server' ? 'server' as const : 'installation' as const, userId: typeof value.userId === 'string' ? value.userId : undefined, collapsed: value.collapsed === true,
            servers: value.servers.filter((server: InstallationServer) => server && typeof server.id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(server.id) && typeof server.name === 'string').map((server: InstallationServer) => ({ id: server.id, publicId: server.publicId, name: server.name, ownerId: String(server.ownerId || ''), version: String(server.version || ''), status: ['ready', 'provisioning'].includes(server.status) ? server.status as 'ready' | 'provisioning' : 'failed' as const, error: typeof server.error === 'string' ? server.error : undefined, origin: typeof server.origin === 'string' ? normalizeServerOrigin(server.origin) : undefined })) }]
        }
        catch { return [] }
      })
      const previous = JSON.parse(localStorage.getItem(ACTIVE) || 'null') as { origin?: unknown; serverId?: unknown } | null
      if (previous && typeof previous.origin === 'string' && typeof previous.serverId === 'string' && installations.value.some(item => item.origin === previous.origin && item.servers.some(server => server.id === previous.serverId))) active.value = { origin: previous.origin, serverId: previous.serverId }
    }
    catch { installations.value = []; active.value = null }
  }

  async function request<T>(origin: string, path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const normalized = normalizeServerOrigin(origin)
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid installation API path')
    const response = await fetch(`${normalized}${path}`, {
      method: options.method || 'GET', credentials: 'include', redirect: 'error',
      headers: { Accept: 'application/json', ...(location.protocol === 'capacitor:' ? { Origin: 'capacitor://localhost' } : {}), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(tokens.value[normalized] ? { Authorization: `Bearer ${tokens.value[normalized]}` } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const payload = await response.json().catch(() => null) as { error?: { message?: string }; message?: string } | null
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message || payload?.message || `Installation request failed (${response.status})`), { status: response.status })
    const token = response.headers.get('set-auth-token')
    if (token) { tokens.value[normalized] = token; try { sessionStorage.setItem(`${TOKEN}${normalized}`, token) } catch { /* Keep the token only in this iframe's memory. */ } }
    return payload as T
  }

  async function discover(address: string) {
    const origin = normalizeServerOrigin(address)
    const discovery = await request<InstallationDiscovery & { ready?: boolean }>(origin, '/.well-known/llll')
    if (discovery.origin !== origin || typeof discovery.name !== 'string' || typeof discovery.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(discovery.id)) throw new Error('Installation discovery returned an invalid identity')
    if (discovery.product !== 'llll' || discovery.apiVersion !== INSTALLATION_API_VERSION || !['installation', 'server', 'client'].includes(discovery.kind)) throw new Error('This installation uses an incompatible L4 API. Open its own client or update it.')
    if (discovery.kind === 'client') return discovery
    const existing = installations.value.find(item => item.origin === origin)
    if (!existing) installations.value.push({ origin, id: discovery.id, name: discovery.name, kind: discovery.kind, servers: discovery.kind === 'server' ? [{ id: discovery.id, name: discovery.name, ownerId: '', version: discovery.version, status: 'ready' }] : [] })
    else { existing.name = discovery.name; existing.id = discovery.id; existing.kind = discovery.kind }
    persist()
    return discovery
  }

  async function refresh(origin: string) {
    const installation = installations.value.find(item => item.origin === origin)
    if (!installation || installation.kind === 'server') return
    const [session, directory] = await Promise.all([
      request<{ user: { id: string }; owner: boolean }>(origin, '/api/installation/session'),
      request<{ servers: InstallationServer[] }>(origin, '/api/installation/servers'),
    ]).catch((error: unknown) => {
      if (typeof error === 'object' && error && 'status' in error && error.status === 401) {
        installation.userId = undefined
        installation.servers = []
        const lostActive = active.value?.origin === origin
        if (lostActive) active.value = null
        persist()
        if (lostActive && import.meta.client && location.pathname !== '/connections') location.assign('/connections')
      }
      throw error
    })
    if (installation.userId && installation.userId !== session.user.id) {
      installation.servers = []
      if (active.value?.origin === origin) active.value = null
    }
    installation.userId = session.user.id
    installation.servers = directory.servers
    if (active.value?.origin === origin && !directory.servers.some(server => server.id === active.value?.serverId && server.status === 'ready')) active.value = null
    persist()
    return session
  }

  function select(origin: string, serverId: string) {
    const installation = installations.value.find(item => item.origin === origin)
    if (!installation?.servers.some(server => server.id === serverId && server.status === 'ready')) throw new Error('Server is not available on this installation')
    active.value = { origin, serverId }
    persist()
  }

  async function logout(origin: string) {
    const installation = installations.value.find(item => item.origin === origin)
    if (installation?.kind === 'installation') await request(origin, '/api/auth/sign-out', { method: 'POST', body: {} })
    tokens.value = Object.fromEntries(Object.entries(tokens.value).filter(([key]) => key !== origin))
    try { sessionStorage.removeItem(`${TOKEN}${origin}`) } catch { /* Embedded storage may be blocked. */ }
    if (installation) { installation.userId = undefined; if (installation.kind === 'installation') installation.servers = [] }
    if (active.value?.origin === origin) active.value = null
    persist()
  }

  function remove(origin: string) {
    installations.value = installations.value.filter(item => item.origin !== origin)
    tokens.value = Object.fromEntries(Object.entries(tokens.value).filter(([key]) => key !== origin))
    try { sessionStorage.removeItem(`${TOKEN}${origin}`) } catch { /* Embedded storage may be blocked. */ }
    if (active.value?.origin === origin) active.value = null
    persist()
  }

  function toggle(origin: string) {
    const item = installations.value.find(installation => installation.origin === origin)
    if (item) { item.collapsed = !item.collapsed; persist() }
  }

  async function connectInBrowser(origin: string) {
    const normalized = normalizeServerOrigin(origin)
    const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(48)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const verifier = random()
    const state = random()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    const redirect = window.__LLLL_OPEN_AUTH__ ? 'llll://connections' : `${location.origin}/connections`
    sessionStorage.setItem('llll.connection-pending', JSON.stringify({ origin: normalized, verifier, state, redirect, expires: Date.now() + 600000 }))
    const target = new URL('/api/auth/connection/authorize', normalized)
    target.search = new URLSearchParams({ redirect_uri: redirect, state, code_challenge: challenge }).toString()
    if (window.__LLLL_OPEN_AUTH__) await window.__LLLL_OPEN_AUTH__(target.toString())
    else location.assign(target.toString())
  }

  async function acceptBrowserConnection() {
    const hash = new URLSearchParams(location.hash.slice(1))
    if (!hash.has('llll_connection')) return false
    history.replaceState(history.state, '', location.pathname + location.search)
    const saved = sessionStorage.getItem('llll.connection-pending')
    sessionStorage.removeItem('llll.connection-pending')
    if (!saved) throw new Error('Start connecting from this client again')
    const pending = JSON.parse(saved) as { origin: string; verifier: string; state: string; redirect: string; expires: number }
    if (pending.expires < Date.now() || hash.get('state') !== pending.state || hash.get('installation') !== pending.origin) throw new Error('Connection callback could not be verified')
    await discover(pending.origin)
    await request(pending.origin, '/api/auth/connection/exchange', { method: 'POST', body: { code: hash.get('llll_connection'), code_verifier: pending.verifier, redirect_uri: pending.redirect } })
    await refresh(pending.origin)
    return pending.origin
  }

  function serverUrl(path: string) {
    if (!activeBase.value || !path.startsWith('/') || path.startsWith('//')) return path
    const url = new URL(`${activeBase.value}${path}`)
    if (path.startsWith('/api/') && activeServer.value?.assetToken) url.searchParams.set('llll_asset', activeServer.value.assetToken)
    return url.toString()
  }
  return { installations, active, activeInstallation, activeServer, activeBase, scope, tokens, initialize, discover, refresh, request, select, logout, remove, toggle, serverUrl, connectInBrowser, acceptBrowserConnection }
}
