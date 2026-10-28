import type { L4Env } from '../../workers/env'
import { fail } from './cf'

/** Agents cannot take a name another Member already uses: in chat and mentions it would read as that person. */
export async function assertAgentNameAvailable(env: L4Env, displayName: string, exceptId?: string) {
  const name = displayName.trim().toLowerCase()
  const taken = await env.DB.prepare(`SELECT 1 AS taken FROM users WHERE status<>'removed' AND id<>?
    AND (lower(trim(display_name))=? OR lower(trim(COALESCE(nickname,'')))=?) LIMIT 1`)
    .bind(exceptId ?? '', name, name).first<{ taken: number }>()
  if (taken) fail(409, 'name_taken', 'Another member already uses this name. Choose a distinct name for the agent.')
}
