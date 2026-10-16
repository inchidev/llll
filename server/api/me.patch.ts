import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authUsers, users } from '../../drizzle/schema'
import { requireUser } from '../utils/auth'
import { cf } from '../utils/cf'
import { getDb } from '../utils/db'
import { parseBody } from '../utils/validate'
import { signalMembersChanged } from '../../workers/member-events'

const bodySchema = z.object({
  displayName: z.string().min(1).max(80),
})

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const displayName = body.displayName.trim()
  await db.update(users).set({ displayName }).where(eq(users.id, me.id))
  await db.update(authUsers).set({ name: displayName, updatedAt: new Date() }).where(eq(authUsers.id, me.id)).catch(() => undefined)
  waitUntil(signalMembersChanged(env, 'main'))
  return { user: { ...me, displayName } }
})
