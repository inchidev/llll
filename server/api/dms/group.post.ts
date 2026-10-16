import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { channels, channelMembers, users } from '../../../drizzle/schema'
import { DM_GROUP_MAX, DM_GROUP_MIN } from '../../../shared/dm'
import { newId, nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { requireUser } from '../../utils/auth'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { toDmDto } from '../../utils/dms'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  userIds: z.array(z.string().min(8)).min(2).max(DM_GROUP_MAX),
  workspaceId: z.literal(WORKSPACE_ID).optional(),
})

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const db = getDb(env.DB)
  const ids = [...new Set([me.id, ...body.userIds])]
  if (ids.length < DM_GROUP_MIN || ids.length > DM_GROUP_MAX) fail(400, 'bad_request', 'Group DMs need 3–25 people')

  const memberRows = await db.select({ userId: users.id }).from(users)
    .where(and(inArray(users.id, ids), eq(users.status, 'active')))
  if (memberRows.length !== ids.length) fail(403, 'forbidden', 'Every participant must be in the workspace')

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
  await db.insert(channelMembers).values(ids.map((userId) => ({
    channelId: id,
    userId,
    hiddenAt: null,
    joinedAt: created,
  })))
  const ch = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0]!
  return { channel: await toDmDto(env, ch, me.id, false) }
})
