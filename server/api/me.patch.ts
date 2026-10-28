import { getServerId } from '../../shared/server-id'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authUsers, users } from '../../drizzle/schema'
import { requireUser } from '../utils/auth'
import { cf, fail } from '../utils/cf'
import { getDb } from '../utils/db'
import { parseBody } from '../utils/validate'
import { signalMembersChanged } from '../../workers/member-events'
import { assertHumanNameAvailable } from '../utils/member-names'

const bodySchema = z.object({
  displayName: z.string().min(1).max(80),
})

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const displayName = body.displayName.trim()
  if (!displayName) fail(400, 'bad_request', 'Enter a display name')
  if (displayName.toLowerCase() !== me.displayName.trim().toLowerCase()) await assertHumanNameAvailable(env, displayName, me.id)
  await db.update(users).set({ displayName }).where(eq(users.id, me.id))
  await db.update(authUsers).set({ name: displayName, updatedAt: new Date() }).where(eq(authUsers.id, me.id)).catch(() => undefined)
  waitUntil(signalMembersChanged(env, await getServerId(env.DB)))
  return { user: { ...me, displayName } }
})
