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

const bodySchema = z.object({
  name: z.string().min(1).max(80).regex(/^[a-z0-9-_]+$/i),
  topic: z.string().max(200).optional(),
  visibility: z.enum(['workspace', 'private']).default('workspace'),
  categoryId: z.string().min(8).nullable().optional(),
  memberIds: z.array(z.string().min(8)).max(100).optional(),
})

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId, Permission.manageChannels)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
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
  const position = Date.now() % 100000
  const channel = {
    id,
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
  if (body.visibility === 'private') {
    const memberIds = [...new Set([member.user.id, ...(body.memberIds ?? [])])]
    const active = await db.select({ id: users.id }).from(users)
      .where(and(inArray(users.id, memberIds), eq(users.status, 'active')))
    if (active.length !== memberIds.length) fail(400, 'bad_request', 'Private channel member is not active')
    await db.batch([
      db.insert(channels).values(channel),
      db.insert(channelMembers).values(memberIds.map(userId => ({ channelId: id, userId, hiddenAt: null, joinedAt: created }))),
    ])
  }
  else {
    await db.insert(channels).values(channel)
  }
  await writeAudit(env, { workspaceId, actorId: member.user.id, action: 'channel.create', targetType: 'channel', targetId: id, meta: { name } })
  return {
    channel: {
      id,
      workspaceId,
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
