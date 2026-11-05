import { decryptSecret, encryptSecret, type EncryptedSecret } from '../shared/encrypted-secret'
import { integrationKeys, type IntegrationKey } from '../shared/integrations'
import { bindingIdentity } from '../shared/binding-identity'
import { readServerSetting, writeServerSetting } from '../shared/server-settings'
import type { L4Env } from './env'

const KEY = 'server.integrations', SCOPE = 'server-integrations', TTL_MS = 30_000
type Saved = Partial<Record<IntegrationKey, string>>
// Holds the value, never a promise: one request must not wait on another request's I/O.
const cache = new WeakMap<object, { saved: Saved; loadedAt: number }>()

export async function loadSavedIntegrations(env: L4Env): Promise<Saved> {
  const stored = await readServerSetting(env.DB, KEY)
  if (!stored || !env.AUTH_SECRET) return {}
  try {
    const parsed = JSON.parse(await decryptSecret(env.AUTH_SECRET, SCOPE, JSON.parse(stored) as EncryptedSecret)) as Saved
    return Object.fromEntries(integrationKeys.filter(key => typeof parsed[key] === 'string').map(key => [key, parsed[key]]))
  } catch { return {} } // A changed AUTH_SECRET cannot read them; deployment variables keep working.
}

export async function saveIntegrations(env: L4Env, saved: Saved) {
  if (!env.AUTH_SECRET) throw new Error('AUTH_SECRET is required')
  if (Object.keys(saved).length) await writeServerSetting(env.DB, KEY, JSON.stringify(await encryptSecret(env.AUTH_SECRET, SCOPE, JSON.stringify(saved))))
  else await env.DB.prepare('DELETE FROM server_settings WHERE key=?').bind(KEY).run()
  cache.delete(bindingIdentity(env.DB))
}

/**
 * This env with the Owner's saved settings filled in, for code that reads `env.X`.
 * A deployment variable wins. Other isolates see a change within 30 seconds.
 */
export async function withIntegrations<T extends L4Env>(env: T): Promise<T> {
  const key = bindingIdentity(env.DB)
  const cached = cache.get(key)
  let saved = cached && Date.now() - cached.loadedAt < TTL_MS ? cached.saved : null
  if (!saved) {
    // Before the first migration there is no table yet, and that is not worth caching.
    try { saved = await loadSavedIntegrations(env); cache.set(key, { saved, loadedAt: Date.now() }) }
    catch { return env }
  }
  return applyIntegrations(env, saved)
}

export function applyIntegrations<T extends L4Env>(env: T, saved: Saved): T {
  const missing = integrationKeys.filter(key => saved[key] && !(env as Record<string, unknown>)[key])
  if (!missing.length) return env
  return { ...env, ...Object.fromEntries(missing.map(key => [key, saved[key]])) }
}
