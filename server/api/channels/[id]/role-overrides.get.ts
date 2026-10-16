import { eq } from 'drizzle-orm'
import { channelRoleOverrides } from '../../../../drizzle/schema'
import { cf } from '../../../utils/cf'
import { requireChannelOverrideManager, toChannelRoleOverrideDto } from '../../../utils/channel-role-overrides'
import { getDb } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  await requireChannelOverrideManager(event, channelId)
  const { env } = cf(event)
  const rows = await getDb(env.DB).select().from(channelRoleOverrides)
    .where(eq(channelRoleOverrides.channelId, channelId))
  return { overrides: rows.map(toChannelRoleOverrideDto) }
})
