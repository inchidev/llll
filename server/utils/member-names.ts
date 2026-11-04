import { extractMentionIds, extractRoleMentionIds, humanizeMentions, roleDisplayName } from '../../shared/mentions'
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

/**
 * The reverse rule: a person cannot take an active Agent's name, or their messages
 * would read as the Agent's. People may still share names with each other.
 */
export async function assertHumanNameAvailable(env: L4Env, displayName: string, userId: string) {
  const name = displayName.trim().toLowerCase()
  const taken = await env.DB.prepare(`SELECT 1 AS taken FROM users WHERE kind='agent' AND status<>'removed' AND id<>?
    AND (lower(trim(display_name))=? OR lower(trim(COALESCE(nickname,'')))=?) LIMIT 1`)
    .bind(userId, name, name).first<{ taken: number }>()
  if (taken) fail(409, 'name_taken', 'An agent already uses this name. Choose a different display name.')
}

/** Replaces `<@id>` and `<@&roleId>` tokens with `@Name`, as people see them in chat. Unknown IDs stay as tokens. */
export async function readableMentions(env: L4Env, texts: string[]): Promise<string[]> {
  const ids = [...new Set(texts.flatMap(extractMentionIds))]
  const roleIds = [...new Set(texts.flatMap(extractRoleMentionIds))]
  const names: Record<string, string> = {}
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const rows = await env.DB.prepare(`SELECT id, COALESCE(nickname, display_name) AS name FROM users WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ id: string; name: string }>()
    for (const row of rows.results ?? []) names[row.id.toLowerCase()] = row.name
  }
  if (roleIds.length) {
    const rows = await env.DB.prepare('SELECT id, key, name FROM roles WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(roleIds)).all<{ id: string; key: string; name: string }>()
    for (const row of rows.results ?? []) names[`&${row.id.toLowerCase()}`] = roleDisplayName(row)
  }
  return texts.map(text => humanizeMentions(text, names))
}
