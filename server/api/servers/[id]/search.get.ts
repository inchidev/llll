import { z } from 'zod'
import type { MessageSearchResponse } from '../../../../shared/types'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { searchServerMessages } from '../../../utils/message-search'

const querySchema = z.object({
  q: z.string().trim().min(1).max(120),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  channelId: z.string().min(8).max(64).optional(),
  authorId: z.string().min(8).max(64).optional(),
})

/** Messages across every channel, DM and thread the member can read. */
export default defineEventHandler(async (event): Promise<MessageSearchResponse> => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success) fail(400, 'bad_request', parsed.error.issues[0]?.message ?? 'Invalid search query')
  return searchServerMessages(cf(event).env, member, parsed.data)
})
