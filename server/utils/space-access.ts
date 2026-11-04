import { creationSpaceId, reachableSpaceIds, spaceSqlList, type SpaceBoundary, type SpaceDeniedKind, type SpaceRole } from '../../shared/spaces'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'

export type SpaceRequest = {
  /** The Space a route policy resolved for this request. Ignored unless the Member belongs to it. */
  spaceScope?: string | null
  /** Set only by a route policy scoped to one Space: lets a Space admin's permissions apply. */
  spaceAdmin?: boolean
}
export type LoadedSpaceBoundary = SpaceBoundary & { adminHere: boolean }

const DENIED_SOURCES: Array<[SpaceDeniedKind, string]> = [
  ['projects', 'SELECT id FROM projects'], ['boards', 'SELECT id FROM task_boards'],
  ['databases', 'SELECT id FROM database_definitions'], ['documents', "SELECT id FROM (SELECT id,space_id FROM data_items WHERE kind='page')"],
  ['canvases', "SELECT id FROM (SELECT id,space_id FROM data_items WHERE kind='canvas')"], ['gadgets', 'SELECT id FROM gadgets'],
  ['connections', 'SELECT id FROM mcp_outbound_connections'], ['environments', 'SELECT id FROM agent_environments'],
]

/**
 * What one Member reaches, and through an Agent, what both reach together. A Server with one
 * Space costs one statement; only a Member outside some Space pays to list what it excludes.
 */
export async function loadSpaceBoundary(env: L4Env, userId: string, options: { delegatedBy?: string | null; scope?: string | null } = {}): Promise<LoadedSpaceBoundary> {
  const delegatedBy = options.delegatedBy ?? null
  // A suspended Space is out of reach for everyone but the Owner, by every path that loads a boundary.
  const rows = ((await env.DB.prepare(`SELECT s.id AS spaceId, m.user_id AS userId, m.role AS role,
      s.suspended_at IS NOT NULL AND ?1 <> (SELECT owner_id FROM server) AS closed FROM spaces s
    LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id IN (?1, ?2)`).bind(userId, delegatedBy ?? userId)
    .all<{ spaceId: string; userId: string | null; role: SpaceRole | null; closed: number }>()).results ?? []).map(row => row.closed ? { ...row, userId: null, role: null } : row)
  const all = new Set(rows.map(row => row.spaceId))
  const of = (id: string) => new Set(rows.filter(row => row.userId === id).map(row => row.spaceId))
  const mine = of(userId), theirs = delegatedBy ? of(delegatedBy) : mine
  let ids = [...mine].filter(id => theirs.has(id))
  if (options.scope && ids.includes(options.scope)) ids = [options.scope]
  const active = ids.length === 1 ? ids[0]! : null
  const adminHere = Boolean(active && rows.some(row => row.spaceId === active && row.userId === userId && row.role === 'admin'))
  if (ids.length === all.size) return { ids, active, denied: {}, adminHere }
  const outside = spaceSqlList(ids)
  // A batch, not a UNION: D1 allows only five terms in a compound SELECT.
  const results = await env.DB.batch([
    ...DENIED_SOURCES.map(([, source]) => env.DB.prepare(`${source} WHERE space_id NOT IN (${outside})`)),
    env.DB.prepare(`SELECT m.user_id AS id FROM space_members m JOIN users u ON u.id = m.user_id AND u.kind = 'agent' WHERE m.space_id NOT IN (${outside})`),
  ])
  const kinds: SpaceDeniedKind[] = [...DENIED_SOURCES.map(([kind]) => kind), 'agents']
  const boundary: SpaceBoundary['denied'] = {}
  kinds.forEach((kind, index) => {
    const rows = (results[index]?.results ?? []) as Array<{ id: string }>
    if (rows.length) boundary[kind] = new Set(rows.map(row => row.id))
  })
  return { ids, active, denied: boundary, adminHere }
}

const SPACE_OF = {
  channel: 'SELECT space_id AS spaceId FROM channels WHERE id = ?',
  category: 'SELECT space_id AS spaceId FROM channel_categories WHERE id = ?',
  message: 'SELECT c.space_id AS spaceId FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?',
  project: 'SELECT space_id AS spaceId FROM projects WHERE id = ?',
  board: 'SELECT space_id AS spaceId FROM task_boards WHERE id = ?',
  task: 'SELECT b.space_id AS spaceId FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?',
  label: 'SELECT b.space_id AS spaceId FROM task_labels l JOIN task_boards b ON b.id = l.board_id WHERE l.id = ?',
  checklist: 'SELECT b.space_id AS spaceId FROM task_checklist_items i JOIN tasks t ON t.id = i.task_id JOIN task_boards b ON b.id = t.board_id WHERE i.id = ?',
  taskAttachment: 'SELECT b.space_id AS spaceId FROM task_attachments a JOIN tasks t ON t.id = a.task_id JOIN task_boards b ON b.id = t.board_id WHERE a.id = ?',
  database: 'SELECT space_id AS spaceId FROM database_definitions WHERE id = ?',
  field: 'SELECT d.space_id AS spaceId FROM database_fields f JOIN database_definitions d ON d.id = f.database_id WHERE f.id = ?',
  item: 'SELECT space_id AS spaceId FROM data_items WHERE id = ?',
  view: 'SELECT d.space_id AS spaceId FROM database_views v JOIN database_definitions d ON d.id = v.database_id WHERE v.id = ?',
  document: 'SELECT space_id AS spaceId FROM data_items WHERE id = ?',
  canvas: 'SELECT space_id AS spaceId FROM data_items WHERE id = ?',
  canvasNode: 'SELECT c.space_id AS spaceId FROM canvas_nodes n JOIN data_items c ON c.id = n.canvas_id WHERE n.id = ?',
  canvasEdge: 'SELECT c.space_id AS spaceId FROM canvas_edges e JOIN data_items c ON c.id = e.canvas_id WHERE e.id = ?',
  gadget: 'SELECT space_id AS spaceId FROM gadgets WHERE id = ?',
  connection: 'SELECT space_id AS spaceId FROM mcp_outbound_connections WHERE id = ?',
  environment: 'SELECT space_id AS spaceId FROM agent_environments WHERE id = ?',
  run: 'SELECT c.space_id AS spaceId FROM agent_runs r JOIN channels c ON c.id = r.channel_id WHERE r.id = ?',
  schedule: 'SELECT c.space_id AS spaceId FROM agent_schedules s JOIN channels c ON c.id = s.channel_id WHERE s.id = ?',
  agent: 'SELECT m.space_id AS spaceId FROM space_members m JOIN users u ON u.id = m.user_id AND u.kind = \'agent\' WHERE m.user_id = ? ORDER BY m.joined_at LIMIT 1',
  attachment: 'SELECT c.space_id AS spaceId FROM attachments a JOIN channels c ON c.id = a.channel_id WHERE a.id = ?',
} as const
export type SpaceResourceKind = keyof typeof SPACE_OF

/** The Space a resource lives in, or null when the resource does not exist. */
export async function spaceOfResource(env: L4Env, kind: SpaceResourceKind, id: string): Promise<string | null> {
  return (await env.DB.prepare(SPACE_OF[kind]).bind(id).first<{ spaceId: string }>())?.spaceId ?? null
}

/** Refuses people from outside a Space: only its Members can be named, invited to or assigned work in it. */
export async function spaceMembersOnly(env: L4Env, spaceId: string, userIds: readonly string[]): Promise<boolean> {
  const unique = [...new Set(userIds)]
  if (!unique.length) return true
  const found = await env.DB.prepare('SELECT COUNT(*) AS count FROM space_members WHERE space_id = ? AND user_id IN (SELECT value FROM json_each(?))')
    .bind(spaceId, JSON.stringify(unique)).first<{ count: number }>()
  return (found?.count ?? 0) === unique.length
}

/** A Space this context shares with a Member, preferring the active one: where a DM between them lives. */
export async function sharedSpaceId(env: L4Env, auth: Pick<AuthorizationContext, 'spaces'>, userId: string): Promise<string | null> {
  const theirs = new Set(((await env.DB.prepare('SELECT space_id AS spaceId FROM space_members WHERE user_id = ?').bind(userId).all<{ spaceId: string }>()).results ?? []).map(row => row.spaceId))
  const preferred = creationSpaceId(auth)
  if (preferred && theirs.has(preferred)) return preferred
  return reachableSpaceIds(auth).find(id => theirs.has(id)) ?? null
}
