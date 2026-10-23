import type { L4Env } from '../../workers/env'
import type { AgentDTO } from '../../shared/types'
export async function agentDirectoryPage(env: L4Env, search: string, page: number) {
  const where = 'FROM agents a JOIN users u ON u.id=a.user_id WHERE instr(lower(u.display_name),?)>0'
  const count = await env.DB.prepare(`SELECT count(*) as total ${where}`).bind(search.toLowerCase()).first<{ total: number }>()
  const rows = await env.DB.prepare(`SELECT u.id,u.display_name as displayName,u.avatar_r2_key as avatarR2Key,a.model,a.harness,a.instructions,a.status,a.last_active_at as lastActiveAt,a.created_at as createdAt,a.updated_at as updatedAt ${where} ORDER BY lower(u.display_name),u.id LIMIT 15 OFFSET ?`).bind(search.toLowerCase(), (page - 1) * 15).all<AgentDTO>()
  return { agents: rows.results, total: count?.total ?? 0 }
}
