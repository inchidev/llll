import type { SidebarThreadDTO } from '../shared/types'
import { Permission } from '../shared/permissions'
type D1Reader = Pick<D1Database, 'prepare'>

/** Counts stop here; the navigation shows 99+. */
export const UNREAD_COUNT_CAP = 100
// D1 binds at most 100 values per statement.
const ID_BATCH = 90

function placeholders(count: number, first: number): string {
  return Array.from({ length: count }, (_, index) => `?${first + index}`).join(', ')
}

/**
 * Each root plus every thread of it the member has opened, with the member's
 * read cursor. Never-opened threads do not keep a parent unread forever.
 * Binds ?1 = member and ?2.. = root ids.
 */
function unreadScopesSql(rootCount: number): string {
  const roots = placeholders(rootCount, 2)
  return `
    SELECT root.id AS root_id, root.id AS scope_id, cr.last_read_message_id AS cursor
    FROM channels root
    LEFT JOIN channel_reads cr ON cr.channel_id = root.id AND cr.user_id = ?1
    WHERE root.id IN (${roots})
    UNION ALL
    SELECT t.parent_id, t.id, cr.last_read_message_id
    FROM channel_reads cr
    JOIN channels t ON t.id = cr.channel_id
    WHERE cr.user_id = ?1 AND cr.last_read_message_id IS NOT NULL
      AND t.type = 'thread' AND t.parent_id IN (${roots})
  `
}

// Seeks messages_live_channel_id_idx and reads at most UNREAD_COUNT_CAP entries.
function boundedUnread(scope: string, cursor: string): string {
  return `(SELECT COUNT(*) FROM (
    SELECT 1 FROM messages m
    WHERE m.channel_id = ${scope} AND m.deleted_at IS NULL AND m.id > COALESCE(${cursor}, '')
    LIMIT ${UNREAD_COUNT_CAP}))`
}

/** Root messages and replies in threads this member opened; deleted messages never count. Binds member, root. */
export const channelUnreadSql = `
  WITH scopes AS (${unreadScopesSql(1)})
  SELECT EXISTS (
    SELECT 1 FROM scopes
    WHERE EXISTS (SELECT 1 FROM messages m
      WHERE m.channel_id = scopes.scope_id AND m.deleted_at IS NULL AND m.id > COALESCE(scopes.cursor, ''))
  ) AS unread
`

/** Binds member, then `channelCount` root ids. */
export function channelUnreadCountsSql(channelCount: number): string {
  if (!Number.isInteger(channelCount) || channelCount < 1) throw new Error('channelCount must be positive')
  return `
    WITH scopes AS (${unreadScopesSql(channelCount)})
    SELECT root_id AS channel_id,
           CAST(MIN(${UNREAD_COUNT_CAP}, SUM(${boundedUnread('scopes.scope_id', 'scopes.cursor')})) AS INTEGER) AS unread_count
    FROM scopes
    GROUP BY root_id
    ORDER BY root_id
  `
}

export async function channelHasUnread(db: D1Reader, userId: string, channelId: string): Promise<boolean> {
  const row = await db.prepare(channelUnreadSql).bind(userId, channelId).first<{ unread: number }>()
  return row?.unread === 1
}

export async function channelUnreadCount(db: D1Reader, userId: string, channelId: string): Promise<number> {
  return (await channelUnreadCounts(db, userId, [channelId])).get(channelId) ?? 0
}

/** Unread messages per root and its opened threads, capped at UNREAD_COUNT_CAP. */
export async function channelUnreadCounts(
  db: D1Reader,
  userId: string,
  channelIds: string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(channelIds)]
  const result = new Map<string, number>()
  for (let offset = 0; offset < ids.length; offset += ID_BATCH) {
    const batch = ids.slice(offset, offset + ID_BATCH)
    const rows = await db.prepare(channelUnreadCountsSql(batch.length))
      .bind(userId, ...batch)
      .all<{ channel_id: string; unread_count: number }>()
    for (const row of rows.results ?? []) result.set(row.channel_id, Number(row.unread_count))
  }
  return result
}

/** The number of unread conversations visible in the member's Chat and DM navigation. */
export async function unreadNavigationCount(db: D1Reader, userId: string): Promise<number> {
  const rows = await db.prepare(`SELECT c.id FROM channels c
    JOIN users u ON u.id = ? AND u.status = 'active'
    JOIN roles r ON r.id = u.role_id CROSS JOIN server s
    WHERE (c.type NOT IN ('dm','thread') AND c.archived_at IS NULL
      AND (c.visibility = 'server' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = u.id))
      AND NOT EXISTS (SELECT 1 FROM email_mailboxes mb WHERE mb.channel_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.discussion_channel_id = c.id))
    OR (c.type = 'dm' AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = u.id AND cm.hidden_at IS NULL)
      AND (u.id = s.owner_id OR (r.permissions_bitmask & ?) != 0 OR NOT EXISTS (
        SELECT 1 FROM channel_members cm JOIN users participant ON participant.id = cm.user_id
        WHERE cm.channel_id = c.id AND participant.kind = 'agent')))`).bind(userId, Permission.useAgents).all<{ id: string }>()
  const counts = await channelUnreadCounts(db, userId, rows.results.map(row => row.id))
  return [...counts.values()].filter(count => count > 0).length
}

/**
 * Threads of the given parents created or active since `since`, or with
 * messages the member has not read in a thread they have opened before.
 * Threads they never opened do not count as unread until opened, matching
 * the parent channel aggregation. Binds ?1 = member, ?2 = since, ?3.. = parents.
 */
export function recentThreadsSql(parentCount: number): string {
  if (!Number.isInteger(parentCount) || parentCount < 1) throw new Error('parentCount must be positive')
  return `
    WITH scoped AS (
      SELECT t.id, t.parent_id, t.name, t.created_at, cr.last_read_message_id AS cursor,
             (SELECT m.created_at FROM messages m WHERE m.channel_id = t.id AND m.deleted_at IS NULL
              ORDER BY m.created_at DESC LIMIT 1) AS last_at
      FROM channels t
      LEFT JOIN channel_reads cr ON cr.channel_id = t.id AND cr.user_id = ?1
      WHERE t.type = 'thread' AND t.parent_id IN (${placeholders(parentCount, 3)})
    ), counted AS (
      SELECT scoped.*, CASE WHEN cursor IS NULL THEN 0 ELSE ${boundedUnread('scoped.id', 'scoped.cursor')} END AS unread
      FROM scoped
    )
    SELECT id, parent_id AS parentId, name AS title,
           COALESCE(last_at, created_at) AS lastMessageAt,
           cursor IS NOT NULL AS opened,
           CAST(unread AS INTEGER) AS unreadCount
    FROM counted
    WHERE COALESCE(last_at, created_at) >= ?2 OR unread > 0
  `
}

export type RecentThreadRow = {
  id: string
  parentId: string
  title: string
  lastMessageAt: string
  opened: boolean
  unreadCount: number
}

export async function recentThreads(db: D1Reader, userId: string, since: string, parentIds: string[]): Promise<RecentThreadRow[]> {
  const ids = [...new Set(parentIds)]
  const result: RecentThreadRow[] = []
  for (let offset = 0; offset < ids.length; offset += ID_BATCH) {
    const batch = ids.slice(offset, offset + ID_BATCH)
    const rows = await db.prepare(recentThreadsSql(batch.length)).bind(userId, since, ...batch).all<RecentThreadRow>()
    for (const row of rows.results ?? []) result.push({ ...row, opened: Boolean(row.opened), unreadCount: Number(row.unreadCount) })
  }
  return result
}

/** Apply the same navigation window and access filter to channels and DMs. */
export async function sidebarThreads(db: D1Reader, userId: string, parentIds: string[]): Promise<SidebarThreadDTO[]> {
  if (!parentIds.length) return []
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const groups = new Map<string, SidebarThreadDTO[]>()
  for (const row of await recentThreads(db, userId, since, parentIds)) {
    const group = groups.get(row.parentId) ?? []
    group.push({ ...row, unread: row.unreadCount > 0 })
    groups.set(row.parentId, group)
  }
  return [...groups.values()].flatMap(group => group
    .sort((a, b) => Number(b.unread) - Number(a.unread) || b.lastMessageAt.localeCompare(a.lastMessageAt))
    .slice(0, 5))
}

/** Latest surviving message across each authorized root and its threads. */
export async function channelLastMessageTimes(db: D1Reader, channelIds: string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(channelIds)]
  const result = new Map<string, string | null>()
  for (let offset = 0; offset < ids.length; offset += ID_BATCH) {
    const batch = ids.slice(offset, offset + ID_BATCH)
    const roots = placeholders(batch.length, 1)
    // One indexed probe per conversation instead of aggregating its history.
    const rows = await db.prepare(`
      WITH scopes AS (
        SELECT id AS root_id, id AS scope_id FROM channels WHERE id IN (${roots})
        UNION ALL
        SELECT parent_id, id FROM channels WHERE type = 'thread' AND parent_id IN (${roots})
      )
      SELECT root_id AS channel_id, MAX((SELECT m.created_at FROM messages m
        WHERE m.channel_id = scopes.scope_id AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC LIMIT 1)) AS last_message_at
      FROM scopes
      GROUP BY root_id
    `).bind(...batch).all<{ channel_id: string, last_message_at: string | null }>()
    for (const row of rows.results ?? []) result.set(row.channel_id, row.last_message_at)
  }
  return result
}
