import type { L4Env } from '../../workers/env'

/** Public admission flag from D1, with the legacy env as a one-time fallback. */
export async function serverRegistrationOpen(env: L4Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT registration_mode FROM auth_settings WHERE id = 1').first<{ registration_mode: string }>()
    if (row) return row.registration_mode === 'open'
  }
  catch {
    // A database without settings keeps the legacy env answer.
  }
  return env.AUTH_REGISTRATION_MODE?.trim() === 'open'
}
