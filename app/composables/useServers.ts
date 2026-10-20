import type { ConnectedServer, ServerDiscovery } from '~~/shared/server'
import { SERVER_API_VERSION } from '~~/shared/server'
import { normalizeServerOrigin } from '~~/shared/client-router'
import { uuidSchema } from '~~/shared/embed'
import { appearanceFromSettings, serverAppearance } from '~~/shared/server-appearance'
import type { ServerDTO } from '~~/shared/types'

export function useServers() {
  const servers = useState<ConnectedServer[]>('llll-servers', () => [])
  const active = useState<{ origin: string; serverId: string } | null>(
    'llll-active-server',
    () => null,
  )
  const activeServer = computed(() =>
    servers.value.find(
      (s) =>
        s.origin === active.value?.origin && s.id === active.value.serverId,
    ),
  )
  const activeBase = computed(() => activeServer.value?.origin || null)
  const scope = computed(
    () =>
      `${activeBase.value || ''}/${activeServer.value?.id || ''}/${activeServer.value?.userId || ''}`,
  )
  const tokens = useState<Record<string, string>>(
    'llll-server-tokens',
    () => ({}),
  )
  function initialize() {
    try {
      const token = sessionStorage.getItem(
        'llll.server-session:' + location.origin,
      )
      if (token) tokens.value[location.origin] = token
    } catch {
      /* In-memory session fallback. */
    }
  }
  async function request<T>(
    origin: string,
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const normalized = normalizeServerOrigin(origin)
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new Error('Invalid Server API path')
    const response = await fetch(normalized + path, {
      method: options.method || 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(tokens.value[normalized]
          ? { Authorization: `Bearer ${tokens.value[normalized]}` }
          : {}),
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const payload = (await response.json()) as {
      error?: { message?: string }
      message?: string
    }
    if (!response.ok)
      throw Object.assign(
        new Error(
          payload?.error?.message ||
            payload?.message ||
            `Server request failed (${response.status})`,
        ),
        { status: response.status },
      )
    const token = response.headers.get('set-auth-token')
    if (token && normalized === location.origin) {
      tokens.value[normalized] = token
      try {
        sessionStorage.setItem('llll.server-session:' + normalized, token)
      } catch {
        /* Keep it in this Client's memory. */
      }
    }
    return payload as T
  }
  async function discover(address: string) {
    const origin = normalizeServerOrigin(address)
    const d = await request<ServerDiscovery>(origin, '/.well-known/llll')
    if (
      d.product !== 'llll' ||
      d.kind !== 'server' ||
      d.origin !== origin ||
      d.apiVersion !== SERVER_API_VERSION ||
      !uuidSchema.safeParse(d.id).success
    )
      throw new Error('This address is not a compatible L4 Server')
    const current = servers.value.find((s) => s.origin === origin)
    if (current)
      Object.assign(current, serverAppearance(d, origin))
    else
      servers.value.push({ origin, ...serverAppearance(d, origin), version: d.version })
    return d
  }
  function updateAppearance(origin: string, row: ServerDTO) {
    const current = servers.value.find(item => item.origin === origin && item.id === row.id)
    if (current) Object.assign(current, appearanceFromSettings(origin, row))
  }
  async function refresh(origin: string) {
    const current = servers.value.find((s) => s.origin === origin)
    if (!current) return
    const result = await request<{ user: { id: string } | null }>(
      origin,
      '/api/me',
    )
    current.userId = result.user?.id
    return result
  }
  function select(origin: string, serverId: string) {
    if (!servers.value.some((s) => s.origin === origin && s.id === serverId))
      throw new Error('Server is unavailable')
    active.value = { origin, serverId }
  }
  async function logout(origin: string) {
    await request(origin, '/api/auth/logout', { method: 'POST' })
    Reflect.deleteProperty(tokens.value, origin)
    try {
      sessionStorage.removeItem('llll.server-session:' + origin)
    } catch {
      /* Memory is already cleared. */
    }
    const s = servers.value.find((s) => s.origin === origin)
    if (s) s.userId = undefined
  }
  function remove(origin: string) {
    servers.value = servers.value.filter((s) => s.origin !== origin)
    if (active.value?.origin === origin) active.value = null
  }
  function serverUrl(path: string) {
    return activeBase.value ? new URL(path, activeBase.value).toString() : path
  }
  return {
    servers,
    active,
    activeServer,
    activeBase,
    scope,
    tokens,
    initialize,
    request,
    discover,
    updateAppearance,
    refresh,
    select,
    logout,
    remove,
    serverUrl,
  }
}
