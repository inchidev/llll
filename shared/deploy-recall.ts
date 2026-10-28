import { serverIconUrl } from './server-appearance'
import { uuidSchema } from './embed'
import { z } from 'zod'

/** Public addresses this browser deployed or discovered in Cloudflare.
 * The deploy session (Cloudflare grant and cookie) lives for about an hour,
 * so /create keeps a local record of what this browser created and offers it
 * again on return even after the session ended.
 */
export type DeployedServer = { origin: string; name: string; completedAt: number; accountId?: string; version?: string | null; id?: string; iconUrl?: string | null; updatedAt?: string }

export type RememberStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

const STORAGE_KEY = 'llll.deploy-recall.v1'
const LIMIT = 20
const revision = z.string().datetime()

const browserStorage = (globalThis as { localStorage?: RememberStorage }).localStorage

function normalize(entry: unknown): DeployedServer | null {
  const value = entry as Partial<DeployedServer> | null
  if (typeof value?.origin !== 'string') return null
  let url: URL
  try { url = new URL(value.origin) } catch { return null }
  if (url.origin !== value.origin) return null
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return null
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return {
    origin: value.origin,
    name: typeof value.name === 'string' ? value.name.slice(0, 100) : '',
    ...(uuidSchema.safeParse(value.id).success ? { id: value.id } : {}),
    ...(value.iconUrl !== undefined ? { iconUrl: serverIconUrl(value.iconUrl, value.origin) } : {}),
    ...(typeof value.updatedAt === 'string' && revision.safeParse(value.updatedAt).success ? { updatedAt: value.updatedAt } : {}),
    completedAt: typeof value.completedAt === 'number' && value.completedAt > 0 ? value.completedAt : Date.now(),
    ...(typeof value.accountId === 'string' && /^[a-f0-9]{32}$/.test(value.accountId) ? { accountId: value.accountId } : {}),
    ...(typeof value.version === 'string' ? { version: value.version.slice(0, 50) } : {}),
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

/** Drops the given origins, so a removed or deleted Server stops reappearing on /create. */
export function forgetDeployedServers(origins: readonly string[], storage: RememberStorage | undefined = browserStorage): DeployedServer[] {
  const remembered = readDeployedServers(storage)
  const next = remembered.filter(item => !origins.includes(item.origin))
  if (next.length !== remembered.length) {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* Read-only storage keeps the old list. */ }
  }
  return next
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
