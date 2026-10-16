import { requireChannelAccess } from '../../utils/guards'
import { cf } from '../../utils/cf'
import { toDmDto } from '../../utils/dms'
import { WORKSPACE_ID } from '../../../shared/ids'
import { threadTitle } from '../../../shared/threads'
import { attachments, messages } from '../../../drizzle/schema'
import { eq } from 'drizzle-orm'
import { getDb } from '../../utils/db'
import type { LiveState } from '../../../shared/types'
import { liveRoom } from '../../utils/live'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, id)
  const { env } = cf(event)
  const ch = access.channel
  if (ch.type === 'dm') {
    return {
      channel: { ...await toDmDto(env, ch, access.user.id, false), permissions: access.perms },
      frozen: access.frozen,
    }
  }
  let title: string | undefined
  if (ch.type === 'thread' && ch.parentMessageId) {
    const db = getDb(env.DB)
    const [root] = await db.select().from(messages).where(eq(messages.id, ch.parentMessageId)).limit(1)
    const attachmentRows = await db.select({ filename: attachments.filename }).from(attachments).where(eq(attachments.messageId, ch.parentMessageId))
    title = threadTitle(root?.content ?? '', attachmentRows.map(row => row.filename))
  }
  let live: LiveState | null = null
  if (ch.liveMeetingId) {
    const current = await liveRoom(env, ch.id).getLive()
    if (current.active) live = current
  }
  return {
    channel: {
      id: ch.id,
      workspaceId: WORKSPACE_ID,
      name: ch.name,
      topic: ch.topic,
      type: ch.type,
      visibility: ch.visibility,
      categoryId: ch.categoryId,
      position: ch.position,
      liveMeetingId: ch.liveMeetingId,
      parentId: ch.parentId,
      parentMessageId: ch.parentMessageId,
      unread: false,
      permissions: access.perms,
      live,
      createdAt: ch.createdAt,
      title,
    },
    frozen: false,
  }
})
