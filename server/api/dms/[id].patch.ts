import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { channels } from '../../../drizzle/schema'
import { requireChannelAccess } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { fanoutDm, toDmDto } from '../../utils/dms'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  name: z.string().min(1).max(80).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, id)
  if (access.channel.type !== 'dm') fail(404, 'not_found', 'Channel not found')
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const db = getDb(env.DB)
  if (body.name !== undefined) {
    await db.update(channels).set({ name: body.name?.trim() || 'dm' }).where(eq(channels.id, id))
    await fanoutDm(env, id, { t: 'dm.update', name: body.name?.trim() || null })
  }
  const ch = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0]!
  return { channel: await toDmDto(env, ch, access.user.id, false) }
})
