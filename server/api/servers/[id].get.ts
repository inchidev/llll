import { eq } from 'drizzle-orm'
import { server } from '../../../drizzle/schema'
import { requireMember } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await requireMember(event, id)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select().from(server).where(eq(server.id, id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Server not found')
  return { server: row }
})
