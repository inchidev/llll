import { getServerId } from '../../../shared/server-id'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { channels, users } from '../../../drizzle/schema'
import { requireUser } from '../../utils/auth'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { openPairDm, toDmDto } from '../../utils/dms'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  userId: z.string().min(8),
  workspaceId: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const body = parseBody(bodySchema, await readBody(event))
  if (body.workspaceId && body.workspaceId !== await getServerId(cf(event).env.DB)) fail(404, 'not_found', 'Server not found')
  if (body.userId === me.id) fail(400, 'bad_request', 'Cannot DM yourself')
  const { env } = cf(event)
  const db = getDb(env.DB)

  const mine = await db.select().from(users).where(and(eq(users.id, me.id), eq(users.status, 'active'))).limit(1)
  if (!mine[0]) fail(403, 'forbidden', 'You are not in this workspace')
  const both = await db.select().from(users).where(and(eq(users.id, body.userId), eq(users.status, 'active'))).limit(1)
  if (!both[0]) fail(403, 'forbidden', 'User is not in this workspace')

  const id = await openPairDm(env, me.id, body.userId)
  const ch = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0]!
  return { channel: await toDmDto(env, ch, me.id, false) }
})
