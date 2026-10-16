import { and, eq } from 'drizzle-orm'
import { users, workspace } from '../../../drizzle/schema'
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
  if (!active[0]) return { workspaces: [] }
  const rows = await db.select({
    id: workspace.id,
    name: workspace.name,
    iconR2Key: workspace.iconR2Key,
    ownerId: workspace.ownerId,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }).from(workspace)
  return { workspaces: rows }
})
