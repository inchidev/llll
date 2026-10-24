import { getServerId } from '../../shared/server-id'
import { and, eq, inArray } from 'drizzle-orm'
import { channels, channelMembers, users } from '../../drizzle/schema'
import { dmTitle } from '../../shared/dm'
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

export async function dmFrozen(env: L4Env, participantIds: string[]): Promise<boolean> {
  const db = getDb(env.DB)
  const rows = await db.select({ userId: users.id }).from(users)
    .where(and(inArray(users.id, participantIds), eq(users.status, 'active')))
  return rows.length !== participantIds.length
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
  const frozen = await dmFrozen(env, participants.map((p) => p.id))
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
