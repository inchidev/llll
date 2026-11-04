import type { L4Env } from '../../workers/env'
import {
  normalizeServerOrigin,
  parseServerOriginList,
  serverOriginHostname,
  type ServerOrigin,
} from '../../shared/server-origins'
import { nowIso } from '../../shared/ids'
import { bindingIdentity } from '../../shared/binding-identity'

export type ServerDomainRequestAction = 'add' | 'remove' | 'primary'
export type ServerDomainRequestStatus = 'pending' | 'running' | 'complete' | 'failed'

export type ServerDomainRequest = {
  id: string
  action: ServerDomainRequestAction
  hostname: string
  status: ServerDomainRequestStatus
  error: string | null
  createdAt: string
  updatedAt: string
}

type OriginRow = {
  origin: string
  hostname: string
  isPrimary: number
}

const CACHE_TTL_MS = 10_000
const originCache = new WeakMap<D1Database, { expiresAt: number, origins: ServerOrigin[] }>()

function safeOrigin(value: string | undefined | null): string | null {
  if (!value?.trim()) return null
  try {
    return normalizeServerOrigin(value)
  }
  catch {
    return null
  }
}

async function storedOrigins(env: L4Env): Promise<ServerOrigin[]> {
  if (!env.DB) return []
  const cached = originCache.get(bindingIdentity(env.DB))
  if (cached && cached.expiresAt > Date.now()) return cached.origins

  let rows: OriginRow[] = []
  try {
    const result = await env.DB.prepare(
      'SELECT origin, hostname, is_primary AS isPrimary FROM server_domains ORDER BY is_primary DESC, created_at ASC',
    ).all<OriginRow>()
    rows = result.results ?? []
  }
  catch {
    // A Server that has not applied 0009 yet still has its primary origin.
  }

  const origins: ServerOrigin[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const origin = safeOrigin(row.origin)
    if (!origin || seen.has(origin)) continue
    seen.add(origin)
    origins.push({
      origin,
      hostname: (row.hostname || serverOriginHostname(origin)).toLowerCase(),
      primary: Number(row.isPrimary) === 1,
    })
  }

  originCache.set(bindingIdentity(env.DB), { expiresAt: Date.now() + CACHE_TTL_MS, origins })
  return origins
}

/**
 * The primary origin plus every working alias. Cloudflare-managed Servers use
 * `server_domains` as the authority; operator-managed Servers use the env list
 * so a removed address stops being trusted immediately. A request origin is
 * never added just because it reached the Worker.
 */
export async function readServerOrigins(env: L4Env, fallbackOrigin?: string): Promise<ServerOrigin[]> {
  const operatorManaged = env.LLLL_RUNTIME?.trim().toLowerCase() === 'celld'
  const configured = safeOrigin(env.PUBLIC_ORIGIN)
  const requestFallback = safeOrigin(fallbackOrigin)
  const stored = operatorManaged ? [] : await storedOrigins(env)
  const operatorOrigins = operatorManaged
    ? parseServerOriginList(env.LLLL_ORIGINS)
    : []
  const result: ServerOrigin[] = stored.map(origin => ({ ...origin }))
  if (operatorManaged) {
    for (const origin of [configured, ...operatorOrigins]) {
      if (!origin || result.some(item => item.origin === origin)) continue
      result.push({ origin, hostname: serverOriginHostname(origin), primary: false })
    }
  }
  else if (!result.length) {
    const only = configured || requestFallback
    if (only) result.push({ origin: only, hostname: serverOriginHostname(only), primary: false })
  }
  const primary = operatorManaged
    ? configured || result[0]?.origin || ''
    : result.find(origin => origin.primary)?.origin || result[0]?.origin || configured || ''
  for (const origin of result) origin.primary = origin.origin === primary
  result.sort((left, right) => Number(right.primary) - Number(left.primary))
  return result
}

export async function primaryServerOrigin(env: L4Env, fallbackOrigin?: string): Promise<string> {
  const origins = await readServerOrigins(env, fallbackOrigin)
  return origins.find(origin => origin.primary)?.origin
    || safeOrigin(env.PUBLIC_ORIGIN)
    || safeOrigin(fallbackOrigin)
    || ''
}

/** Use the address the browser reached when it is listed; otherwise the primary. */
export async function requestServerOrigin(env: L4Env, requestOrigin: string, fallbackOrigin?: string): Promise<string> {
  const requested = safeOrigin(requestOrigin)
  const origins = await readServerOrigins(env, fallbackOrigin ?? requestOrigin)
  if (requested && origins.some(origin => origin.origin === requested)) return requested
  return origins.find(origin => origin.primary)?.origin
    || safeOrigin(env.PUBLIC_ORIGIN)
    || requested
    || ''
}

export async function allowedServerOrigins(env: L4Env, fallbackOrigin?: string): Promise<string[]> {
  return (await readServerOrigins(env, fallbackOrigin)).map(origin => origin.origin)
}

/**
 * Create the primary row once from the operator-configured `PUBLIC_ORIGIN`.
 * The D1 write is safe to repeat and never overrides an owner's choice. A
 * request's Host is never persisted: whichever name first reached the Worker
 * must not become the address used for auth links and trusted origins. Without
 * `PUBLIC_ORIGIN` (unconfigured local development) nothing is stored and
 * `readServerOrigins` computes a per-request fallback instead.
 */
export async function ensurePrimaryServerOrigin(env: L4Env): Promise<void> {
  if (env.LLLL_RUNTIME?.trim().toLowerCase() === 'celld') return
  if (!env.DB) return
  const origin = safeOrigin(env.PUBLIC_ORIGIN)
  if (!origin) return
  try {
    const primary = await env.DB.prepare('SELECT 1 AS present FROM server_domains WHERE is_primary = 1 LIMIT 1').first()
    if (primary) return
  }
  catch {
    // The table arrives with migration 0009; keep the computed fallback until then.
    return
  }
  const hostname = serverOriginHostname(origin)
  const createdAt = nowIso()
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO server_domains(origin, hostname, is_primary, created_at) VALUES (?, ?, 0, ?)',
      ).bind(origin, hostname, createdAt),
      env.DB.prepare(
        'UPDATE server_domains SET is_primary = 1 WHERE origin = ? AND NOT EXISTS (SELECT 1 FROM server_domains WHERE is_primary = 1)',
      ).bind(origin),
    ])
  }
  catch {
    // Before 0009 is applied the computed list still has the configured primary.
  }
  originCache.delete(bindingIdentity(env.DB))
}

export async function listServerDomainRequests(env: L4Env): Promise<ServerDomainRequest[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  try {
    const result = await env.DB.prepare(
      `SELECT id, action, hostname, status, error, created_at AS createdAt, updated_at AS updatedAt
       FROM server_domain_requests WHERE created_at >= ? ORDER BY created_at DESC LIMIT 10`,
    ).bind(since).all<ServerDomainRequest>()
    const rows = (result.results ?? []).filter(row => ['add', 'remove', 'primary'].includes(row.action))
    const expired = rows.filter(row => (row.status === 'pending' || row.status === 'running') && row.updatedAt < stale)
    if (expired.length) {
      const error = 'The request expired before Cloudflare completed it.'
      await env.DB.prepare(
        "UPDATE server_domain_requests SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('pending', 'running') AND updated_at < ?",
      ).bind(error, nowIso(), stale).run()
      for (const row of expired) {
        row.status = 'failed'
        row.error = error
      }
    }
    return rows
  }
  catch {
    return []
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function hashServerDomainToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function createServerDomainRequest(
  env: L4Env,
  input: { action: ServerDomainRequestAction, hostname: string },
): Promise<{ request: ServerDomainRequest, token: string }> {
  const id = crypto.randomUUID()
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const createdAt = nowIso()
  const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE server_domain_requests SET status = 'failed', error = 'The request expired before Cloudflare completed it.', updated_at = ? WHERE status IN ('pending', 'running') AND updated_at < ?",
    ).bind(createdAt, stale),
    env.DB.prepare(
      `INSERT INTO server_domain_requests(id, action, hostname, token_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(id, input.action, input.hostname, await hashServerDomainToken(token), createdAt, createdAt),
  ])
  return {
    request: { id, action: input.action, hostname: input.hostname, status: 'pending', error: null, createdAt, updatedAt: createdAt },
    token,
  }
}
