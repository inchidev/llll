import { decryptSecret, encryptSecret } from '../../../shared/encrypted-secret'
import { cloudflareGrantSchema, refreshCloudflareGrant } from '../../../shared/cloudflare-oauth'
import type { InstallationEnv } from './env'

const key = 'CLOUDFLARE_OAUTH_GRANT'
export async function cloudflareCredentials(env: InstallationEnv): Promise<InstallationEnv> {
  if (env.CLOUDFLARE_API_TOKEN) return env
  const row = await env.INSTALLATION_DB.prepare('SELECT value FROM integration_settings WHERE key = ?').bind(key).first<{ value: string }>()
  if (!row) return env
  let grant = cloudflareGrantSchema.parse(JSON.parse(await decryptSecret(env.AUTH_SECRET, `settings:${key}`, JSON.parse(row.value))))
  if (grant.expiresAt < Date.now() + 120000) {
    const lease = await env.INSTALLATION_DB.prepare('INSERT INTO oauth_refresh_lock(id,lease_until) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until WHERE lease_until < ? RETURNING lease_until').bind(Date.now() + 30000, Date.now()).first<{ lease_until: number }>()
    if (!lease) throw Object.assign(new Error('Cloudflare connection is refreshing. Try again shortly.'), { status: 503 })
    try {
      // Re-read after acquiring the lease: another request may already have rotated it.
      const current = await env.INSTALLATION_DB.prepare('SELECT value FROM integration_settings WHERE key = ?').bind(key).first<{ value: string }>()
      grant = cloudflareGrantSchema.parse(JSON.parse(await decryptSecret(env.AUTH_SECRET, `settings:${key}`, JSON.parse(current!.value))))
      if (grant.expiresAt < Date.now() + 120000) {
        grant = await refreshCloudflareGrant(grant)
        const encrypted = JSON.stringify(await encryptSecret(env.AUTH_SECRET, `settings:${key}`, JSON.stringify(grant)))
        await env.INSTALLATION_DB.prepare('UPDATE integration_settings SET value = ? WHERE key = ?').bind(encrypted, key).run()
      }
    }
    finally { await env.INSTALLATION_DB.prepare('DELETE FROM oauth_refresh_lock WHERE id = 1 AND lease_until = ?').bind(lease.lease_until).run() }
  }
  return { ...env, CLOUDFLARE_API_TOKEN: grant.accessToken }
}
