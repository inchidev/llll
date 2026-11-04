import { normalizeServerOrigin } from '~~/shared/client-router'
import { SERVER_API_VERSION, uuidSchema } from '~~/shared/server'

/**
 * Other Servers this browser keeps next to this one. A list lives on one Server's origin, on one device: that
 * Server's own page can read it, and no other Server can. Going to a listed Server tells it only where you came from, the first time,
 * so it can offer the way back. It asks first: anyone can write such a link.
 */
export type ServerLink = { origin: string; id: string; name: string; introduced?: boolean }

const STORAGE_KEY = 'llll.server-links.v1'
const FROM_PARAM = 'from'

function read(): ServerLink[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as unknown
    if (!Array.isArray(saved)) return []
    return saved.filter((item): item is ServerLink => typeof item?.origin === 'string' && typeof item?.id === 'string' && typeof item?.name === 'string')
  }
  catch { return [] }
}

/** A Server's public identity. Sends no credentials, and a Server cannot answer for another address. */
export async function readServerIdentity(address: string, fetcher: typeof fetch = fetch): Promise<ServerLink> {
  const origin = normalizeServerOrigin(address)
  const response = await fetcher(origin + '/.well-known/llll', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(7000) })
    .catch(() => { throw new Error('Could not reach this address') })
  if (!response.ok) throw new Error('Could not reach this address')
  const data = await response.json().catch(() => null) as { product?: unknown; kind?: unknown; apiVersion?: unknown; id?: unknown; name?: unknown; origin?: unknown; aliases?: unknown } | null
  const aliases = Array.isArray(data?.aliases) ? data.aliases : []
  const parsed = uuidSchema.safeParse(data?.id)
  if (data?.product !== 'llll' || data.kind !== 'server' || data.apiVersion !== SERVER_API_VERSION || !parsed.success || (data.origin !== origin && !aliases.includes(origin)))
    throw new Error('This address is not a compatible L4 Server')
  return { origin, id: parsed.data, name: typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 100) : new URL(origin).host }
}

/** The address a link back offers, once. Removes it from the page's address. */
export function takeLinkBack(): string | null {
  const hash = new URLSearchParams(location.hash.replace(/^#/u, ''))
  const from = hash.get(FROM_PARAM)
  if (from === null) return null
  hash.delete(FROM_PARAM)
  const rest = hash.toString()
  history.replaceState(history.state, '', location.pathname + location.search + (rest ? `#${rest}` : ''))
  try {
    const origin = normalizeServerOrigin(from)
    return origin === location.origin ? null : origin
  }
  catch { return null }
}

export function useServerLinks() {
  const links = useState<ServerLink[]>('llll-server-links', () => [])
  const adding = useState('llll-server-link-adding', () => false)
  const offered = useState<ServerLink | null>('llll-server-link-offered', () => null)
  // The apps keep the device's list themselves, and a Server's page can't reach it.
  const available = import.meta.client && !window.__LLLL_NATIVE_SHOW_SERVERS__

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(links.value)) }
    catch { /* The list still works until this page closes. */ }
  }
  function load() { links.value = read() }
  function save(link: ServerLink) {
    const known = links.value.find(item => item.id === link.id || item.origin === link.origin)
    if (known) Object.assign(known, { ...link, introduced: known.introduced || link.introduced })
    else links.value.push(link)
    persist()
  }
  async function add(address: string) {
    const link = await readServerIdentity(address)
    if (link.origin === location.origin) throw new Error('This is the Server you are on')
    save(link)
  }
  function remove(origin: string) {
    links.value = links.value.filter(item => item.origin !== origin)
    persist()
  }
  /** Keeps names current. A Server that doesn't answer stays as it was. */
  async function refresh() {
    await Promise.all(links.value.map(async (link) => {
      const fresh = await readServerIdentity(link.origin).catch(() => null)
      if (fresh && fresh.id === link.id) link.name = fresh.name
    }))
    persist()
  }
  /** The first visit says where it came from, and a Server that came this way already knows. */
  function open(link: ServerLink) {
    const first = !link.introduced
    if (first) { link.introduced = true; persist() }
    location.assign(first ? `${link.origin}/#${new URLSearchParams({ [FROM_PARAM]: location.origin })}` : link.origin)
  }
  async function offer(origin: string) {
    const link = await readServerIdentity(origin).catch(() => null)
    if (link && !links.value.some(item => item.id === link.id || item.origin === link.origin)) offered.value = link
  }
  function acceptOffer() {
    // It already knows this Server: it just linked here.
    if (offered.value) save({ ...offered.value, introduced: true })
    offered.value = null
  }
  return { links, adding, offered, available, load, add, remove, refresh, open, offer, acceptOffer, declineOffer: () => { offered.value = null } }
}
