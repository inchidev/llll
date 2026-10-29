import type { L4Env } from './env'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../shared/encrypted-secret'

const key = 'push.vapid.v1'
type VapidKeys = { subject: string; publicKey: string; privateKey: string }

function configuredKeys(env: L4Env): VapidKeys | null {
  if (!env.VAPID_SUBJECT?.trim() || !env.VAPID_PUBLIC_KEY?.trim() || !env.VAPID_PRIVATE_KEY?.trim()) return null
  return { subject: env.VAPID_SUBJECT.trim(), publicKey: env.VAPID_PUBLIC_KEY.trim(), privateKey: env.VAPID_PRIVATE_KEY.trim() }
}

function subject(env: L4Env): string | null {
  try { const url = new URL(env.PUBLIC_ORIGIN ?? ''); if (url.protocol === 'https:') return url.origin } catch { /* Try the administrator address. */ }
  const email = env.ADMIN_EMAIL?.trim()
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? `mailto:${email}` : null
}

export function canConfigurePush(env: L4Env): boolean {
  if (configuredKeys(env)) return true
  // Never silently replace a partially configured operator-managed identity.
  if (env.VAPID_SUBJECT || env.VAPID_PUBLIC_KEY || env.VAPID_PRIVATE_KEY) return false
  return Boolean(env.AUTH_SECRET && subject(env))
}

export async function loadPushKeys(env: L4Env): Promise<VapidKeys | null> {
  const configured = configuredKeys(env)
  if (configured) return configured
  if (!canConfigurePush(env)) return null
  const row = await env.DB.prepare('SELECT value FROM server_settings WHERE key=?').bind(key).first<{ value: string }>()
  if (!row) return null
  return JSON.parse(await decryptSecret(env.AUTH_SECRET!, key, JSON.parse(row.value) as EncryptedSecret)) as VapidKeys
}

export async function ensurePushKeys(env: L4Env): Promise<VapidKeys | null> {
  const existing = await loadPushKeys(env)
  if (existing || !canConfigurePush(env)) return existing
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  // Construct the uncompressed point from JWK coordinates. Some runtimes
  // return SPKI bytes for exportKey('raw'), which browsers cannot subscribe to.
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error('Could not create push identity')
  const decode = (value: string) => atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(44, '='))
  const point = '\x04' + decode(jwk.x) + decode(jwk.y)
  if (point.length !== 65) throw new Error('Could not create push identity')
  const publicKey = btoa(point).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  const privateKey = jwk.d
  const sealed = JSON.stringify(await encryptSecret(env.AUTH_SECRET!, key, JSON.stringify({ subject: subject(env)!, publicKey, privateKey })))
  await env.DB.prepare('INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING')
    .bind(key, sealed, new Date().toISOString()).run()
  return loadPushKeys(env)
}
