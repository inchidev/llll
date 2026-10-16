import type { PublicUser, UserKind } from '../../shared/types'

export type DmSearchMember = PublicUser & {
  handle: string | null
  nickname: string | null
}

type DmSearchRow = {
  id: string
  kind: UserKind
  display_name: string
  avatar_r2_key: string | null
  handle: string | null
  nickname: string | null
}

export async function searchDmMembers(database: D1Database, viewerId: string, query: string, includeAgents = true): Promise<DmSearchMember[]> {
  const filter = query
    ? 'AND (u.display_name LIKE ? OR u.nickname LIKE ? OR u.handle LIKE ?)'
    : ''
  const kindFilter = includeAgents ? '' : "AND u.kind = 'human'"
  const statement = database.prepare(
     `SELECT u.id, u.kind, u.display_name, u.avatar_r2_key, u.handle, u.nickname
     FROM users u
     WHERE u.status = 'active' AND u.id <> ? ${kindFilter} ${filter}
     LIMIT 20`,
  )
  const pattern = `%${query}%`
  const rows = query
    ? await statement.bind(viewerId, pattern, pattern, pattern).all<DmSearchRow>()
    : await statement.bind(viewerId).all<DmSearchRow>()

  return rows.results.map(row => ({
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    avatarR2Key: row.avatar_r2_key,
    handle: row.handle,
    nickname: row.nickname,
  }))
}
