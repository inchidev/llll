import { eq } from 'drizzle-orm'
import { server } from '../../drizzle/schema'
import { getServerId } from '../../shared/server-id'
import { requireMember } from '../utils/guards'
import { cf, fail } from '../utils/cf'
import { getDb } from '../utils/db'

export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const id = await getServerId(env.DB)
  await requireMember(event, id)
  const row = (await getDb(env.DB).select().from(server).where(eq(server.id, id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Server not found')
  return { server: row }
})
