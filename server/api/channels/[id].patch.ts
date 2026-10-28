import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { channelCategories, channels, users } from '../../../drizzle/schema'
import { nowIso } from '../../../shared/ids'
import { hasPermission, Permission } from '../../../shared/permissions'
import { requireChannelMember } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { parseBody } from '../../utils/validate'
import { writeAudit } from '../../utils/messages'
import { channelAudience, isChatChannel, signalChannelsChanged } from '../../utils/channel-lifecycle'
import { refreshChannelVisibility } from '../../utils/private-channel-members'

const bodySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  topic: z.string().max(200).optional(),
  categoryId: z.string().min(8).nullable().optional(),
  visibility: z.enum(['server', 'private']).optional(),
  /** Members besides the creator when a server channel becomes private. */
  memberIds: z.array(z.string().min(8)).max(100).optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const member = await requireChannelMember(event, id, Permission.manageChannels)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  if (body.categoryId !== undefined && (member.channel.type === 'dm' || member.channel.type === 'thread')) {
    fail(400, 'bad_request', 'Only server channels can belong to categories')
  }
  if (body.categoryId) {
    const category = await db.select({ id: channelCategories.id }).from(channelCategories)
      .where(eq(channelCategories.id, body.categoryId)).limit(1)
    if (!category[0]) fail(400, 'bad_request', 'Channel category not found')
  }
  if (body.memberIds && body.visibility !== 'private') fail(400, 'bad_request', 'Choose members only when making a channel private')
  if (body.visibility) await changeVisibility(member, body.visibility, body.memberIds ?? [])
  const patch: Partial<typeof channels.$inferInsert> = { updatedAt: nowIso() }
  if (body.name) patch.name = body.name.trim().toLowerCase()
  if (body.topic !== undefined) patch.topic = body.topic
  if (body.categoryId !== undefined) patch.categoryId = body.categoryId
  if (Object.keys(patch).length > 1) {
    await db.update(channels).set(patch).where(eq(channels.id, id))
    await writeAudit(env, {
      serverId: member.serverId,
      actorId: member.user.id,
      action: 'channel.update',
      targetType: 'channel',
      targetId: id,
      meta: { fields: Object.keys(body).filter(field => field !== 'visibility' && field !== 'memberIds') },
    })
    const root = member.channel.parentId ?? id
    waitUntil(signalChannelsChanged(env, member.serverId, { parentIds: member.channel.type === 'thread' ? [root] : [] }, await channelAudience(env, root)))
  }
  if (body.visibility) await refreshChannelVisibility(env, member.serverId, id, body.visibility)
  const row = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0]
  return { channel: row }

  /**
   * Visibility follows member management: only the channel's creator changes who can see it.
   * Becoming private keeps the creator and the chosen members; becoming open to the Server
   * drops the member list and treats the history as read for those who gain it.
   */
  async function changeVisibility(actor: typeof member, visibility: 'server' | 'private', memberIds: string[]) {
    const channel = actor.channel
    if (!await isChatChannel(env, channel)) fail(400, 'invalid_channel', 'Only server channels can change visibility')
    if (channel.createdBy && channel.createdBy !== actor.user.id) fail(403, 'forbidden', 'Only the channel creator can change who can see it')
    if (!channel.createdBy && visibility === 'server') fail(403, 'forbidden', 'Assign a channel creator before opening this channel')
    if (channel.visibility === visibility) return
    const at = nowIso()
    if (visibility === 'private') {
      const ids = [...new Set([actor.user.id, ...memberIds])]
      const active = await db.select({ id: users.id, kind: users.kind }).from(users)
        .where(and(inArray(users.id, ids), eq(users.status, 'active')))
      if (active.length !== ids.length) fail(400, 'invalid_member', 'Private channel member is not active')
      if (active.some(user => user.kind === 'agent') && !hasPermission(actor.perms, Permission.useAgents)) fail(403, 'forbidden', 'Use agents permission is required to add an Agent')
      const [changed] = await env.DB.batch([
        env.DB.prepare(`UPDATE channels SET visibility='private', created_by=COALESCE(created_by, ?), updated_at=? WHERE id=? AND visibility='server' RETURNING id`)
          .bind(actor.user.id, at, channel.id),
        // Threads record their parent's visibility when they are created.
        env.DB.prepare(`UPDATE channels SET visibility='private' WHERE parent_id=? AND EXISTS(SELECT 1 FROM channels WHERE id=? AND visibility='private' AND updated_at=?)`)
          .bind(channel.id, channel.id, at),
        env.DB.prepare(`DELETE FROM channel_members WHERE channel_id=? AND EXISTS(SELECT 1 FROM channels WHERE id=? AND visibility='private' AND updated_at=?)`)
          .bind(channel.id, channel.id, at),
        ...ids.map(userId => env.DB.prepare(`INSERT OR IGNORE INTO channel_members(channel_id,user_id,hidden_at,joined_at)
          SELECT ?,?,NULL,? WHERE EXISTS(SELECT 1 FROM channels WHERE id=? AND visibility='private' AND updated_at=?)`)
          .bind(channel.id, userId, at, channel.id, at)),
      ])
      if (!(changed as D1Result).results?.length) return
    }
    else {
      const [changed] = await env.DB.batch([
        env.DB.prepare(`UPDATE channels SET visibility='server', updated_at=? WHERE id=? AND visibility='private' RETURNING id`).bind(at, channel.id),
        env.DB.prepare(`UPDATE channels SET visibility='server' WHERE parent_id=? AND EXISTS(SELECT 1 FROM channels WHERE id=? AND visibility='server' AND updated_at=?)`)
          .bind(channel.id, channel.id, at),
        // Newly admitted Members start with the existing history read, as when they are added.
        env.DB.prepare(`INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at)
          SELECT c.id,u.id,MAX(m.id),? FROM users u CROSS JOIN channels c JOIN messages m ON m.channel_id=c.id
          WHERE u.status='active' AND (c.id=? OR c.parent_id=?)
            AND NOT EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=? AND cm.user_id=u.id)
            AND EXISTS(SELECT 1 FROM channels WHERE id=? AND visibility='server' AND updated_at=?)
          GROUP BY c.id,u.id ON CONFLICT(channel_id,user_id) DO NOTHING`).bind(at, channel.id, channel.id, channel.id, channel.id, at),
        env.DB.prepare(`DELETE FROM channel_members WHERE channel_id=? AND EXISTS(SELECT 1 FROM channels WHERE id=? AND visibility='server' AND updated_at=?)`)
          .bind(channel.id, channel.id, at),
      ])
      if (!(changed as D1Result).results?.length) return
    }
    await writeAudit(env, {
      serverId: actor.serverId,
      actorId: actor.user.id,
      action: 'channel.visibility',
      targetType: 'channel',
      targetId: channel.id,
      meta: { visibility, ...(visibility === 'private' ? { memberIds } : {}) },
    })
  }
})
