import { DurableObject } from 'cloudflare:workers'
import { LLLL_OAUTH_CLIENT_ID, refreshOAuthGrant } from '@llll/admin-core'
import type { AdminEnv } from './env'
import { ensureSchema, nowIso } from './utils/db'
import { decryptSecret, encryptSecret } from './utils/secrets'

type CredentialRow = {
  kind: 'oauth' | 'token'
  secret_encrypted: string
  access_encrypted: string | null
  access_expires_at: number | null
}

const SECRET_SCOPE = 'cloudflare-credential'
const ACCESS_SCOPE = 'cloudflare-access-token'

/**
 * One per Admin. It serializes use of the Cloudflare credential: OAuth refresh
 * tokens rotate on every refresh, so two refreshes at once would lose the grant.
 */
export class AdminCoordinator extends DurableObject<AdminEnv> {
  private cached: { token: string, expiresAt: number } | null = null
  private pending: Promise<string> | null = null

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.token
    this.pending ??= this.load().finally(() => { this.pending = null })
    return this.pending
  }

  /** Forget the cached token after the credential changed. */
  async reset(): Promise<void> {
    this.cached = null
  }

  private async load(): Promise<string> {
    const db = this.env.ADMIN_DB
    await ensureSchema(db)
    let row = await db.prepare('SELECT kind, secret_encrypted, access_encrypted, access_expires_at FROM credential WHERE id = ?')
      .bind('main').first<CredentialRow>()
    const seed = this.env.CLOUDFLARE_OAUTH_REFRESH_TOKEN?.trim()
    if (!row && seed) {
      // The refresh token handed over at deploy becomes the Admin's own grant.
      row = { kind: 'oauth', secret_encrypted: await encryptSecret(this.env.ADMIN_SECRET, SECRET_SCOPE, seed), access_encrypted: null, access_expires_at: null }
      await db.prepare(
        `INSERT INTO credential (id, kind, secret_encrypted, scopes, updated_at) VALUES ('main', 'oauth', ?, '', ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(row.secret_encrypted, nowIso()).run()
    }
    if (!row) throw Object.assign(new Error('Connect Cloudflare in the L4 Admin'), { statusCode: 409 })

    const secret = await decryptSecret(this.env.ADMIN_SECRET, SECRET_SCOPE, row.secret_encrypted)
    if (row.kind === 'token') {
      this.cached = { token: secret, expiresAt: Date.now() + 10 * 60_000 }
      return secret
    }
    if (row.access_encrypted && (row.access_expires_at ?? 0) > Date.now() + 60_000) {
      const token = await decryptSecret(this.env.ADMIN_SECRET, ACCESS_SCOPE, row.access_encrypted)
      this.cached = { token, expiresAt: row.access_expires_at! }
      return token
    }
    try {
      const tokens = await refreshOAuthGrant({ refreshToken: secret, clientId: this.env.CLOUDFLARE_OAUTH_CLIENT_ID || LLLL_OAUTH_CLIENT_ID })
      await db.prepare(
        `UPDATE credential SET secret_encrypted = ?, access_encrypted = ?, access_expires_at = ?, scopes = CASE WHEN ? = '' THEN scopes ELSE ? END,
           problem = NULL, updated_at = ? WHERE id = 'main'`,
      ).bind(
        await encryptSecret(this.env.ADMIN_SECRET, SECRET_SCOPE, tokens.refreshToken),
        await encryptSecret(this.env.ADMIN_SECRET, ACCESS_SCOPE, tokens.accessToken),
        tokens.expiresAt,
        tokens.scopes,
        tokens.scopes,
        nowIso(),
      ).run()
      this.cached = { token: tokens.accessToken, expiresAt: tokens.expiresAt }
      return tokens.accessToken
    }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Cloudflare refused the connection'
      await db.prepare(`UPDATE credential SET problem = ?, updated_at = ? WHERE id = 'main'`).bind(message, nowIso()).run()
      throw Object.assign(new Error(`Reconnect Cloudflare: ${message}`), { statusCode: 409 })
    }
  }
}
