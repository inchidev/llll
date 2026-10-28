import { extractMentionIds, humanizeMentions } from '../../shared/mentions'
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

/** Replaces `<@id>` tokens with `@Name`, as people see them in chat. Unknown IDs stay as tokens. */
export async function readableMentions(env: L4Env, texts: string[]): Promise<string[]> {
  const ids = [...new Set(texts.flatMap(extractMentionIds))]
  const names: Record<string, string> = {}
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const rows = await env.DB.prepare(`SELECT id, COALESCE(nickname, display_name) AS name FROM users WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ id: string; name: string }>()
    for (const row of rows.results ?? []) names[row.id.toLowerCase()] = row.name
  }
  return texts.map(text => humanizeMentions(text, names))
}
