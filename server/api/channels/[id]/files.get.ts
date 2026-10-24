import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { attachments, channels, messages, users } from '../../../../drizzle/schema'
import type { ChannelFileDTO } from '../../../../shared/types'
import { requireChannelAccess } from '../../../utils/guards'
import { retryDeletedFiles } from '../../../../shared/file-cleanup'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { attachmentDto, toPublicUser } from '../../../utils/messages'

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  await requireChannelAccess(event, channelId)
  const { env, waitUntil } = cf(event)
  waitUntil(retryDeletedFiles(env))
  const db = getDb(env.DB)
  const threadRows = await db.select({ id: channels.id }).from(channels).where(eq(channels.parentId, channelId))
  const conversationIds = [channelId, ...threadRows.map(thread => thread.id)]
  const rows = await db.select({ attachment: attachments, uploader: users })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(users, eq(users.id, attachments.uploaderId))
    .where(and(inArray(attachments.channelId, conversationIds), isNull(messages.deletedAt)))
    .orderBy(desc(attachments.createdAt))

  const files: ChannelFileDTO[] = rows.flatMap(({ attachment, uploader }) => attachment.messageId
    ? [{
        ...attachmentDto(attachment),
        messageId: attachment.messageId,
        uploader: toPublicUser(uploader),
        createdAt: attachment.createdAt,
      }]
    : [])
  return { files }
})
