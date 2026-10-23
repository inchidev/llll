import { extractMentionIds } from '../../shared/mentions'
import { threadTitle } from '../../shared/threads'
/** Resolve only names referenced by an already authorized root message. */
export async function messageThreadTitle(db: D1Database, content: string, filenames: string[] = []): Promise<string> {
  const ids = extractMentionIds(content).slice(0, 50)
  if (!ids.length) return threadTitle(content, filenames)
  const rows = await db.prepare(`SELECT id,display_name as name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: string; name: string }>()
  return threadTitle(content, filenames, Object.fromEntries(rows.results.map(row => [row.id, row.name])))
}
