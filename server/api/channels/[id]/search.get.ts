import { z } from 'zod'
import type { MessageSearchHitDTO, MessageSearchResponse } from '../../../../shared/types'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import {
  decodeMessageSearchCursor,
  encodeMessageSearchCursor,
  messageSearchExpression,
  SEARCH_MESSAGES_SQL,
} from '../../../utils/message-search'

const querySchema = z.object({
  q: z.string().trim().min(1).max(120),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

type SearchRow = {
  id: string
  channelId: string
  authorId: string
  content: string
  editedAt: string | null
  createdAt: string
  authorKind: 'human' | 'agent'
  authorDisplayName: string
  authorAvatarR2Key: string | null
}

export default defineEventHandler(async (event): Promise<MessageSearchResponse> => {
  const channelId = getRouterParam(event, 'id')!
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success) fail(400, 'bad_request', parsed.error.issues[0]?.message ?? 'Invalid search query')

  // Authorization happens before the FTS query. Threads inherit their parent access.
  const access = await requireChannelAccess(event, channelId)
  const expression = messageSearchExpression(parsed.data.q)
  if (!expression) fail(400, 'bad_request', 'Search query must contain a letter or number')

  const scope = { channelId, query: expression }
  const cursor = parsed.data.cursor
    ? decodeMessageSearchCursor(parsed.data.cursor, scope)
    : null
  if (parsed.data.cursor && !cursor) fail(400, 'bad_request', 'Invalid search cursor')

  const { env } = cf(event)
  const pageSize = parsed.data.limit
  const result = await env.DB.prepare(SEARCH_MESSAGES_SQL).bind(
    expression,
    channelId,
    cursor ? 1 : 0,
    cursor?.createdAt ?? '',
    cursor?.createdAt ?? '',
    cursor?.id ?? '',
    pageSize + 1,
  ).all<SearchRow>()
  const rows = result.results ?? []
  const hasMore = rows.length > pageSize
  const page = hasMore ? rows.slice(0, pageSize) : rows
  const channel = {
    id: access.channel.id,
    name: access.channel.name,
    type: access.channel.type,
    parentId: access.channel.parentId,
    parentMessageId: access.channel.parentMessageId,
  }
  const hits: MessageSearchHitDTO[] = page.map(row => ({
    id: row.id,
    channel,
    author: {
      id: row.authorId,
      kind: row.authorKind,
      displayName: row.authorDisplayName,
      avatarR2Key: row.authorAvatarR2Key,
    },
    content: row.content,
    editedAt: row.editedAt,
    createdAt: row.createdAt,
  }))
  const last = page.at(-1)

  return {
    hits,
    nextCursor: hasMore && last
      ? encodeMessageSearchCursor({ createdAt: last.createdAt, id: last.id }, scope)
      : null,
  }
})
