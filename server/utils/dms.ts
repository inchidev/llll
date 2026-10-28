import { getServerId } from '../../shared/server-id'
import { and, eq, inArray } from 'drizzle-orm'
import type { channels } from '../../drizzle/schema'
import { channelMembers, users } from '../../drizzle/schema'
import { dmFrozen, dmTitle } from '../../shared/dm'
import { newId, nowIso } from '../../shared/ids'
import type { ChannelDTO, PublicUser } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { asRpc } from './cf'
import { getDb } from './db'
import { toPublicUser } from './messages'
import { liveRoom } from './live'
import { channelLastMessageTimes } from '../../workers/unread'

export async function loadParticipants(env: L4Env, channelId: string): Promise<PublicUser[]> {
  const db = getDb(env.DB)
  const parts = await db.select().from(channelMembers).where(eq(channelMembers.channelId, channelId))
  if (!parts.length) return []
  const rows = await db.select().from(users).where(inArray(users.id, parts.map((p) => p.userId)))
  return rows.map(toPublicUser)
}

export async function participantsFrozen(env: L4Env, participantIds: string[]): Promise<boolean> {
  if (participantIds.length !== 2) return false
  const db = getDb(env.DB)
  const rows = await db.select({ userId: users.id }).from(users)
    .where(and(inArray(users.id, participantIds), eq(users.status, 'active')))
  return dmFrozen(participantIds.length, rows.length)
}

export async function toDmDto(
  env: L4Env,
  ch: typeof channels.$inferSelect,
  meId: string,
  unread: boolean,
): Promise<ChannelDTO> {
  const participants = await loadParticipants(env, ch.id)
  const lastMessages = await channelLastMessageTimes(env.DB, [ch.id])
  const agent = participants.length === 2 ? participants.find(p => p.kind === 'agent') : null
  const snippet = agent ? await env.DB.prepare(`SELECT m.content FROM messages m WHERE m.author_id=? AND m.deleted_at IS NULL AND (m.channel_id=? OR m.channel_id IN (SELECT id FROM channels WHERE parent_id=?)) ORDER BY m.id DESC LIMIT 1`).bind(agent.id, ch.id, ch.id).first<{ content: string }>() : null
  const working = agent ? await env.DB.prepare("SELECT id FROM agent_runs WHERE agent_id=? AND (channel_id=? OR channel_id IN (SELECT id FROM channels WHERE parent_id=?)) AND status='running' LIMIT 1").bind(agent.id, ch.id, ch.id).first() : null
  const frozen = await participantsFrozen(env, participants.map((p) => p.id))
  let live: ChannelDTO['live'] = null
  if (ch.liveMeetingId) {
    try {
      const current = await Promise.race([
        liveRoom(env, ch.id).getLive(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
      ])
      if (current?.active) live = current
    }
    catch { /* the sidebar shows the room once its realtime event arrives */ }
  }
  return {
    id: ch.id,
    serverId: (await getServerId(env.DB)),
    name: ch.name,
    topic: ch.topic,
    type: 'dm',
    visibility: 'private',
    categoryId: null,
    position: ch.position,
    liveMeetingId: ch.liveMeetingId,
    parentId: ch.parentId,
    parentMessageId: ch.parentMessageId,
    unread,
    live,
    createdAt: ch.createdAt,
    title: dmTitle(ch.name === 'dm' ? null : ch.name, participants, meId),
    participants,
    dmKind: ch.dmKind,
    dmOwnerId: ch.dmOwnerId,
    frozen,
    lastMessageAt: lastMessages.get(ch.id) ?? null,
    ...(agent ? { lastAgentMessage: snippet?.content.slice(0, 180) ?? null, agentWorking: Boolean(working) } : {}),
  }
}

/** Canonical, order-independent key of a 1:1 DM. */
export function dmPairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

export async function findPairDm(env: L4Env, meId: string, otherId: string): Promise<string | null> {
  const key = dmPairKey(meId, otherId)
  const keyed = await env.DB.prepare("SELECT id FROM channels WHERE dm_pair_key = ? AND type = 'dm'").bind(key).first<{ id: string }>()
  if (keyed) return keyed.id
  // A pair created before its key existed claims the key on first reuse.
  const row = await env.DB.prepare(
    `SELECT a.channel_id as id
     FROM channel_members a
     JOIN channel_members b ON a.channel_id = b.channel_id AND b.user_id = ?
     JOIN channels c ON c.id = a.channel_id AND c.type = 'dm' AND c.dm_kind = 'pair' AND c.dm_pair_key IS NULL
     WHERE a.user_id = ?
       AND (SELECT COUNT(*) FROM channel_members p WHERE p.channel_id = a.channel_id) = 2
     ORDER BY c.created_at, c.id
     LIMIT 1`,
  ).bind(otherId, meId).first<{ id: string }>()
  if (!row) return null
  await env.DB.prepare('UPDATE OR IGNORE channels SET dm_pair_key = ? WHERE id = ? AND dm_pair_key IS NULL').bind(key, row.id).run()
  const winner = await env.DB.prepare("SELECT id FROM channels WHERE dm_pair_key = ? AND type = 'dm'").bind(key).first<{ id: string }>()
  return winner?.id ?? row.id
}

/** Find-or-create. Concurrent opens race on the unique pair key; every caller gets the winner. */
export async function openPairDm(env: L4Env, meId: string, otherId: string): Promise<string> {
  const db = getDb(env.DB)
  let id = await findPairDm(env, meId, otherId)
  if (!id) {
    const candidate = newId()
    const created = nowIso()
    const key = dmPairKey(meId, otherId)
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO channels (id, name, topic, type, visibility, position, dm_kind, dm_pair_key, created_at, updated_at)
        VALUES (?, 'dm', '', 'dm', 'private', 0, 'pair', ?, ?, ?) ON CONFLICT DO NOTHING`).bind(candidate, key, created, created),
      env.DB.prepare(`INSERT INTO channel_members (channel_id, user_id, hidden_at, joined_at)
        SELECT ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM channels WHERE id = ?)`).bind(candidate, meId, created, candidate),
      env.DB.prepare(`INSERT INTO channel_members (channel_id, user_id, hidden_at, joined_at)
        SELECT ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM channels WHERE id = ?)`).bind(candidate, otherId, created, candidate),
    ])
    const winner = await env.DB.prepare("SELECT id FROM channels WHERE dm_pair_key = ? AND type = 'dm'").bind(key).first<{ id: string }>()
    if (!winner) throw new Error('Direct message could not be opened')
    if (winner.id === candidate) return candidate
    id = winner.id
  }
  await db.update(channelMembers).set({ hiddenAt: null }).where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, meId)))
  return id
}

export async function unhideAll(env: L4Env, channelId: string) {
  const db = getDb(env.DB)
  await db.update(channelMembers).set({ hiddenAt: null }).where(eq(channelMembers.channelId, channelId))
}

export async function fanoutDm(env: L4Env, channelId: string, msg: unknown) {
  try {
    const stub = asRpc<{ fanout: (m: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${channelId}`))
    await stub.fanout(msg)
  }
  catch { /* local without DO */ }
}

export async function requireServerUser(env: L4Env, userId: string): Promise<boolean> {
  const db = getDb(env.DB)
  const row = (await db.select().from(users).where(and(eq(users.id, userId), eq(users.status, 'active'))).limit(1))[0]
  return Boolean(row)
}
