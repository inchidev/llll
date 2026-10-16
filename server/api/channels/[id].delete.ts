import { eq } from 'drizzle-orm'
import { channels } from '../../../drizzle/schema'
import { Permission } from '../../../shared/permissions'
import { requireChannelMember } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { writeAudit } from '../../utils/messages'
import { revalidateLiveRooms } from '../../utils/live'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const member = await requireChannelMember(event, id, Permission.manageChannels)
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const remaining = (await db.select().from(channels)).filter((channel) => channel.type !== 'dm' && channel.type !== 'thread')
  if (remaining.length <= 1) fail(400, 'bad_request', 'Cannot delete the last channel')
  await db.delete(channels).where(eq(channels.id, id))
  await writeAudit(env, { workspaceId: member.workspaceId, actorId: member.user.id, action: 'channel.delete', targetType: 'channel', targetId: id })
  // A deleted conversation's Live room ends.
  waitUntil(revalidateLiveRooms(env, [id]))
  return { ok: true }
})
