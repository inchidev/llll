import { and, eq } from 'drizzle-orm'
import { users, server } from '../../../drizzle/schema'
import { requireUser } from '../../utils/auth'
import { cf } from '../../utils/cf'
import { getDb } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const active = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, user.id), eq(users.status, 'active')))
    .limit(1)
  if (!active[0]) return { servers: [] }
  const rows = await db.select({
    id: server.id,
    name: server.name,
    iconR2Key: server.iconR2Key,
    ownerId: server.ownerId,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  }).from(server)
  return { servers: rows }
})
