import { eq } from 'drizzle-orm'
import { channels } from '../../../drizzle/schema'
import { Permission } from '../../../shared/permissions'
import { requireChannelMember } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { writeAudit } from '../../utils/messages'
import { revalidateLiveRooms } from '../../utils/live'
import { channelAudience, chatChannelCount, conversationTree, deletionBlocker, isChatChannel, signalChannelsChanged } from '../../utils/channel-lifecycle'

const blocked = (message: string) => fail(409, 'conversation_retained', message)

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const member = await requireChannelMember(event, id, Permission.manageChannels)
  const { env, waitUntil } = cf(event)
  const channel = member.channel
  if (channel.type === 'dm') fail(400, 'bad_request', 'Direct messages cannot be deleted')
  // An archived channel is already out of the count, so deleting it never leaves Chat empty.
  if (!channel.archivedAt && await isChatChannel(env, channel) && await chatChannelCount(env) <= 1) fail(400, 'bad_request', 'Cannot delete the last channel')
  const blocker = await deletionBlocker(env, id)
  if (blocker) blocked(blocker)
  const deletedIds = await conversationTree(env, channel)
  const audience = await channelAudience(env, channel.parentId ?? id)
  try {
    await getDb(env.DB).delete(channels).where(eq(channels.id, id))
  }
  catch (error) {
    // A Run admitted after the check above still holds a reference.
    if (/FOREIGN KEY/iu.test(`${String(error)} ${String((error as { cause?: unknown })?.cause)}`)) blocked((await deletionBlocker(env, id)) ?? 'This conversation is still referenced, so it cannot be deleted.')
    throw error
  }
  await writeAudit(env, { serverId: member.serverId, actorId: member.user.id, action: 'channel.delete', targetType: 'channel', targetId: id })
  // A deleted conversation's Live room ends.
  waitUntil(revalidateLiveRooms(env, [id]))
  waitUntil(signalChannelsChanged(env, member.serverId, { deletedIds, parentIds: channel.parentId ? [channel.parentId] : [] }, audience))
  return { ok: true }
})
