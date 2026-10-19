/** Completed servers this browser deployed through the web.
 * The deploy session (Cloudflare grant and cookie) lives for about an hour,
 * so /deploy keeps a local record of what this browser created and offers it
 * again on return even after the session ended.
 */
export type DeployedServer = { origin: string; name: string; completedAt: number }

export type RememberStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

const STORAGE_KEY = 'llll.deploy-recall.v1'
const LIMIT = 20

const browserStorage = (globalThis as { localStorage?: RememberStorage }).localStorage

function normalize(entry: unknown): DeployedServer | null {
  const value = entry as Partial<DeployedServer> | null
  if (typeof value?.origin !== 'string') return null
  let url: URL
  try { url = new URL(value.origin) } catch { return null }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return null
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return {
    origin: value.origin,
    name: typeof value.name === 'string' ? value.name.slice(0, 100) : '',
    completedAt: typeof value.completedAt === 'number' && value.completedAt > 0 ? value.completedAt : Date.now(),
  }
}

export function readDeployedServers(storage: RememberStorage | undefined = browserStorage): DeployedServer[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const saved: unknown = JSON.parse(raw)
    if (!Array.isArray(saved)) return []
    return saved.map(normalize).filter((entry): entry is DeployedServer => entry !== null)
  } catch { return [] }
}

/** Upserts by origin, newest first, capped so the list cannot grow unbounded. */
export function recordDeployedServer(entry: DeployedServer, storage: RememberStorage | undefined = browserStorage): DeployedServer[] {
  const parsed = normalize(entry)
  if (!parsed) return readDeployedServers(storage)
  const remembered = readDeployedServers(storage)
  const next = [parsed, ...remembered.filter(item => item.origin !== parsed.origin)].slice(0, LIMIT)
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* Private-mode storage can be read-only; keep the in-memory list. */ }
  return next
}
