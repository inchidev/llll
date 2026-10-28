import { and, inArray, eq } from 'drizzle-orm'
import { z } from 'zod'
import { channelCategories, channelMembers, channels, users } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { parseBody } from '../../../utils/validate'
import { writeAudit } from '../../../utils/messages'
import { signalChannelsChanged } from '../../../utils/channel-lifecycle'

const bodySchema = z.object({
  name: z.string().min(1).max(80).regex(/^[a-z0-9-_]+$/i),
  topic: z.string().max(200).optional(),
  visibility: z.enum(['server', 'private']).default('server'),
  categoryId: z.string().min(8).nullable().optional(),
  memberIds: z.array(z.string().min(8)).max(100).optional(),
})

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId, Permission.manageChannels)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const id = newId()
  const created = nowIso()
  const name = body.name.toLowerCase()
  const type = 'text'
  const categoryId = body.categoryId ?? null
  if (categoryId) {
    const category = await db.select({ id: channelCategories.id }).from(channelCategories)
      .where(eq(channelCategories.id, categoryId)).limit(1)
    if (!category.length) fail(400, 'bad_request', 'Channel category not found')
  }
  const position = Number((await env.DB.prepare("SELECT COALESCE(MAX(position),0)+1 AS position FROM channels WHERE type='text'").first<{ position: number }>())?.position ?? 1)
  const channel = {
    id,
    createdBy: member.user.id,
    name,
    topic: body.topic ?? '',
    type,
    visibility: body.visibility,
    categoryId,
    position,
    liveMeetingId: null,
    parentId: null,
    parentMessageId: null,
    createdAt: created,
    updatedAt: created,
  } as const
  let audience: string[] | undefined
  if (body.visibility === 'private') {
    const memberIds = [...new Set([member.user.id, ...(body.memberIds ?? [])])]
    const active = await db.select({ id: users.id }).from(users)
      .where(and(inArray(users.id, memberIds), eq(users.status, 'active')))
    if (active.length !== memberIds.length) fail(400, 'bad_request', 'Private channel member is not active')
    audience = memberIds
    await db.batch([
      db.insert(channels).values(channel),
      db.insert(channelMembers).values(memberIds.map(userId => ({ channelId: id, userId, hiddenAt: null, joinedAt: created }))),
    ])
  }
  else {
    await db.insert(channels).values(channel)
  }
  await writeAudit(env, { serverId, actorId: member.user.id, action: 'channel.create', targetType: 'channel', targetId: id, meta: { name } })
  waitUntil(signalChannelsChanged(env, serverId, {}, audience))
  return {
    channel: {
      id,
      serverId,
      name,
      topic: body.topic ?? '',
      type,
      visibility: body.visibility,
      categoryId,
      position,
      liveMeetingId: null,
      parentId: null,
      parentMessageId: null,
      unread: false,
      live: null,
      createdAt: created,
    },
  }
})
