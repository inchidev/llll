import { getServerId } from '../../shared/server-id'
import { and, eq, inArray } from 'drizzle-orm'
import { channels, channelMembers, users } from '../../drizzle/schema'
import { dmFrozen, dmTitle } from '../../shared/dm'
import { newId, nowIso } from '../../shared/ids'
import type { ChannelDTO, PublicUser } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { asRpc } from './cf'
import { getDb } from './db'
import { toPublicUser } from './messages'
import { liveRoom } from './live'
import { channelLastMessageTimes } from '../../workers/unread'

type UserRow = typeof users.$inferSelect
// D1 binds at most 100 values per statement.
const ID_BATCH = 90

/** Participant rows for many conversations in one query per batch. */
export async function loadParticipantRows(env: L4Env, channelIds: string[]): Promise<Map<string, UserRow[]>> {
  const ids = [...new Set(channelIds)]
  const result = new Map<string, UserRow[]>(ids.map(id => [id, []]))
  const db = getDb(env.DB)
  for (let offset = 0; offset < ids.length; offset += ID_BATCH) {
    const rows = await db.select({ channelId: channelMembers.channelId, user: users }).from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .where(inArray(channelMembers.channelId, ids.slice(offset, offset + ID_BATCH)))
    for (const row of rows) result.get(row.channelId)!.push(row.user)
  }
  return result
}

export async function loadParticipants(env: L4Env, channelId: string): Promise<PublicUser[]> {
  return ((await loadParticipantRows(env, [channelId])).get(channelId) ?? []).map(toPublicUser)
}

/** The Agent's latest reply and running state across each 1:1 Agent DM and its threads. */
async function agentDmActivity(env: L4Env, pairs: Array<{ channelId: string, agentId: string }>) {
  const result = new Map<string, { lastAgentMessage: string | null, agentWorking: boolean }>()
  for (let offset = 0; offset < pairs.length; offset += ID_BATCH / 2) {
    const batch = pairs.slice(offset, offset + ID_BATCH / 2)
    const rows = await env.DB.prepare(`
      WITH pairs(channel_id, agent_id) AS (VALUES ${batch.map(() => '(?, ?)').join(', ')})
      SELECT p.channel_id AS channelId,
        (SELECT m.content FROM messages m WHERE m.author_id = p.agent_id AND m.deleted_at IS NULL
          AND (m.channel_id = p.channel_id OR m.channel_id IN (SELECT id FROM channels WHERE parent_id = p.channel_id))
          ORDER BY m.id DESC LIMIT 1) AS content,
        EXISTS (SELECT 1 FROM agent_runs r WHERE r.agent_id = p.agent_id AND r.status = 'running'
          AND (r.channel_id = p.channel_id OR r.channel_id IN (SELECT id FROM channels WHERE parent_id = p.channel_id))) AS working
      FROM pairs p
    `).bind(...batch.flatMap(pair => [pair.channelId, pair.agentId])).all<{ channelId: string, content: string | null, working: number }>()
    for (const row of rows.results ?? []) {
      result.set(row.channelId, { lastAgentMessage: row.content?.slice(0, 180) ?? null, agentWorking: Boolean(row.working) })
    }
  }
  return result
}

async function dmLive(env: L4Env, channelId: string): Promise<ChannelDTO['live']> {
  try {
    const current = await Promise.race([
      liveRoom(env, channelId).getLive(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
    ])
    return current?.active ? current : null
  }
  catch { return null /* the sidebar shows the room once its realtime event arrives */ }
}

/**
 * Hydrate DMs with a fixed number of queries regardless of how many there are.
 * Live rooms are asked only for DMs that have one.
 */
export async function toDmDtos(
  env: L4Env,
  rows: Array<typeof channels.$inferSelect>,
  meId: string,
  unread: (channelId: string) => boolean,
  preloaded?: Map<string, UserRow[]>,
): Promise<ChannelDTO[]> {
  if (!rows.length) return []
  const ids = rows.map(row => row.id)
  const participantRows = preloaded ?? await loadParticipantRows(env, ids)
  const agents = new Map<string, string>()
  for (const id of ids) {
    const parts = participantRows.get(id) ?? []
    const agent = parts.length === 2 ? parts.find(part => part.kind === 'agent') : undefined
    if (agent) agents.set(id, agent.id)
  }
  const [serverId, lastMessages, activity, live] = await Promise.all([
    getServerId(env.DB),
    channelLastMessageTimes(env.DB, ids),
    agentDmActivity(env, [...agents].map(([channelId, agentId]) => ({ channelId, agentId }))),
    Promise.all(rows.filter(row => row.liveMeetingId).map(async row => [row.id, await dmLive(env, row.id)] as const)),
  ])
  const liveRooms = new Map(live)
  return rows.map((ch) => {
    const parts = participantRows.get(ch.id) ?? []
    const participants = parts.map(toPublicUser)
    return {
      id: ch.id,
      serverId,
      name: ch.name,
      topic: ch.topic,
      type: 'dm',
      visibility: 'private',
      categoryId: null,
      position: ch.position,
      liveMeetingId: ch.liveMeetingId,
      parentId: ch.parentId,
      parentMessageId: ch.parentMessageId,
      unread: unread(ch.id),
      live: liveRooms.get(ch.id) ?? null,
      createdAt: ch.createdAt,
      title: dmTitle(ch.name === 'dm' ? null : ch.name, participants, meId),
      participants,
      dmKind: ch.dmKind,
      dmOwnerId: ch.dmOwnerId,
      frozen: dmFrozen(parts.length, parts.filter(part => part.status === 'active').length),
      lastMessageAt: lastMessages.get(ch.id) ?? null,
      ...(agents.has(ch.id) ? activity.get(ch.id) ?? { lastAgentMessage: null, agentWorking: false } : {}),
    }
  })
}

export async function toDmDto(
  env: L4Env,
  ch: typeof channels.$inferSelect,
  meId: string,
  unread: boolean,
): Promise<ChannelDTO> {
  return (await toDmDtos(env, [ch], meId, () => unread))[0]!
}


export async function findPairDm(env: L4Env, meId: string, otherId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT a.channel_id as id
     FROM channel_members a
     JOIN channel_members b ON a.channel_id = b.channel_id AND b.user_id = ?
     JOIN channels c ON c.id = a.channel_id AND c.type = 'dm' AND c.dm_kind = 'pair'
     WHERE a.user_id = ?
       AND (SELECT COUNT(*) FROM channel_members p WHERE p.channel_id = a.channel_id) = 2
     LIMIT 1`,
  ).bind(otherId, meId).first<{ id: string }>()
  return row?.id ?? null
}

export async function openPairDm(env: L4Env, meId: string, otherId: string): Promise<string> {
  const existing = await findPairDm(env, meId, otherId)
  const db = getDb(env.DB)
  if (existing) {
    await db.update(channelMembers).set({ hiddenAt: null }).where(and(eq(channelMembers.channelId, existing), eq(channelMembers.userId, meId)))
    return existing
  }
  const id = newId()
  const created = nowIso()
  await db.insert(channels).values({
    id,
    name: 'dm',
    topic: '',
    type: 'dm',
    visibility: 'private',
    position: 0,
    liveMeetingId: null,
    parentId: null,
    parentMessageId: null,
    createdAt: created,
    updatedAt: created,
  })
  await db.insert(channelMembers).values([
    { channelId: id, userId: meId, hiddenAt: null, joinedAt: created },
    { channelId: id, userId: otherId, hiddenAt: null, joinedAt: created },
  ])
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
