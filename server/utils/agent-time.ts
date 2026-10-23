import { readServerSetting } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'
export async function agentTimeContext(env: L4Env, now = new Date()) {
  let timezone = await readServerSetting(env.DB, 'server.timezone') || 'UTC'
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(now) } catch { timezone = 'UTC' }
  return { utc: now.toISOString(), timezone, localTime: new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' }).format(now) }
}
