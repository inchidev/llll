import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import { messages } from '../../../../../../drizzle/schema'
import type { MessageContextResponse } from '../../../../../../shared/types'
import { requireChannelAccess } from '../../../../../utils/guards'
import { cf, fail } from '../../../../../utils/cf'
import { getDb } from '../../../../../utils/db'
import { hydrateMessages } from '../../../../../utils/messages'

const querySchema = z.object({
  before: z.coerce.number().int().min(0).max(50).default(25),
  after: z.coerce.number().int().min(0).max(50).default(25),
})

export default defineEventHandler(async (event): Promise<MessageContextResponse> => {
  const channelId = getRouterParam(event, 'id')!
  const messageId = getRouterParam(event, 'messageId')!
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success) fail(400, 'bad_request', parsed.error.issues[0]?.message ?? 'Invalid context query')

  // Resolve channel access first so private-channel existence and messages cannot leak.
  const access = await requireChannelAccess(event, channelId)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const target = (await db.select().from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
    .limit(1))[0]
  if (!target) fail(404, 'not_found', 'Message not found')

  const beforeRows = await db.select().from(messages)
    .where(and(
      eq(messages.channelId, channelId),
      or(
        lt(messages.createdAt, target.createdAt),
        and(eq(messages.createdAt, target.createdAt), lt(messages.id, target.id)),
      ),
    ))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(parsed.data.before + 1)
  const afterRows = await db.select().from(messages)
    .where(and(
      eq(messages.channelId, channelId),
      or(
        gt(messages.createdAt, target.createdAt),
        and(eq(messages.createdAt, target.createdAt), gt(messages.id, target.id)),
      ),
    ))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(parsed.data.after + 1)

  const hasOlder = beforeRows.length > parsed.data.before
  const hasNewer = afterRows.length > parsed.data.after
  const beforePage = beforeRows.slice(0, parsed.data.before).reverse()
  const afterPage = afterRows.slice(0, parsed.data.after)
  const rows = [...beforePage, target, ...afterPage]
  const hydrated = await hydrateMessages(env, rows, access.user.id)

  return {
    messages: hydrated,
    targetId: target.id,
    targetIndex: beforePage.length,
    hasOlder,
    hasNewer,
  }
})
