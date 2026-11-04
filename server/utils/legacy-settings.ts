import type { L4Env } from '../../workers/env'
import { ensureOwnerSetup, readOwnerSetupEnv } from './owner-setup'
import { MAIL_DEFAULT_LOCAL_PART, readServerSetting, writeServerSetting } from '../../shared/server-settings'
import { serverMailDomains } from './server-mail'

/**
 * One-time bridge for Servers installed before settings moved to D1. The
 * installer keeps these bindings for the first upload only; the next metadata
 * update removes them. The operation is idempotent and never overwrites a
 * setting the owner already saved.
 */
export async function migrateLegacySettings(env: L4Env): Promise<void> {
  if (!env.DB) return
  const ready = Boolean(await env.DB.prepare('SELECT 1 FROM server LIMIT 1').first())
  if (!ready) {
    const legacySetup = readOwnerSetupEnv(env)
    if (legacySetup) await ensureOwnerSetup(env.DB, legacySetup)
  }
  const mode = env.AUTH_REGISTRATION_MODE?.trim()
  if (mode === 'open' || mode === 'invite_only') {
    await env.DB.prepare(
      'INSERT INTO auth_settings (id, registration_mode) VALUES (1, ?) ON CONFLICT(id) DO NOTHING',
    ).bind(mode).run()
  }
  if (env.MAIL_APP_HOSTNAME?.trim()) {
    if (!await readServerSetting(env.DB, 'mail_app_hostname')) {
      await writeServerSetting(env.DB, 'mail_app_hostname', env.MAIL_APP_HOSTNAME.trim().toLowerCase())
    }
    const domains = serverMailDomains(env)
    if (domains.length && !await readServerSetting(env.DB, 'mail_domains')) {
      await writeServerSetting(env.DB, 'mail_domains', JSON.stringify(domains))
    }
  }
  if (env.MAIL_DEFAULT_LOCAL_PART?.trim() && !await readServerSetting(env.DB, MAIL_DEFAULT_LOCAL_PART)) {
    await writeServerSetting(env.DB, MAIL_DEFAULT_LOCAL_PART, env.MAIL_DEFAULT_LOCAL_PART.trim())
  }
}
