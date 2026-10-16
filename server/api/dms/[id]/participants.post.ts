import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { channels, channelMembers } from '../../../../drizzle/schema'
import { DM_GROUP_MAX } from '../../../../shared/dm'
import { nowIso } from '../../../../shared/ids'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { fanoutDm, loadParticipants, requireWorkspaceUser, toDmDto } from '../../../utils/dms'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  userId: z.string().min(8),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, id)
  if (access.channel.type !== 'dm') fail(404, 'not_found', 'Channel not found')
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const db = getDb(env.DB)
  const inWorkspace = await requireWorkspaceUser(env, body.userId)
  if (!inWorkspace) fail(403, 'forbidden', 'User is not in this workspace')

  const existing = (await db.select().from(channelMembers).where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, body.userId))).limit(1))[0]
  if (!existing) {
    const count = (await db.select().from(channelMembers).where(eq(channelMembers.channelId, id))).length
    if (count >= DM_GROUP_MAX) fail(400, 'bad_request', 'Group is full')
    await db.insert(channelMembers).values({
      channelId: id,
      userId: body.userId,
      hiddenAt: null,
      joinedAt: nowIso(),
    })
  }
  else if (existing.hiddenAt) {
    await db.update(channelMembers).set({ hiddenAt: null }).where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, body.userId)))
  }

  const participants = await loadParticipants(env, id)
  await fanoutDm(env, id, { t: 'dm.participants', participants })
  const ch = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0]!
  return { channel: await toDmDto(env, ch, access.user.id, false) }
})
