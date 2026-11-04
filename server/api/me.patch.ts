import { getServerId } from '../../shared/server-id'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authUsers, users } from '../../drizzle/schema'
import { normalizeUsername, usernameSchema } from '../../shared/account'
import { isUsernameConflict } from '../utils/account-identity'
import { requireUser } from '../utils/auth'
import { authFromEvent } from '../utils/better-auth'
import { writeAudit } from '../utils/messages'
import { cf, fail } from '../utils/cf'
import { getDb } from '../utils/db'
import { parseBody } from '../utils/validate'
import { signalMembersChanged } from '../../workers/member-events'
import { assertHumanNameAvailable, memberNameKey } from '../utils/member-names'

const bodySchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  username: usernameSchema.optional(),
})

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  let { displayName, username, displayUsername } = me
  if (body.username !== undefined && body.username !== me.displayUsername) {
    const renamed = normalizeUsername(body.username) !== me.username
    // Through the adapter, so the username plugin validates and normalizes it. Cloudflare
    // Access identities have no session for its /update-user. A change of case stays the same name.
    const { internalAdapter } = await (await authFromEvent(event)).$context
    try {
      await internalAdapter.updateUser(me.id, renamed ? { username: body.username, displayUsername: body.username } : { displayUsername: body.username })
    }
    catch (error) {
      if (isUsernameConflict(error)) fail(409, 'username_taken', 'That username is taken')
      throw error
    }
    displayUsername = body.username
    username = normalizeUsername(body.username)
    // A Member's mention handle stays as it is: old mentions and habits keep working.
    if (renamed) await writeAudit(env, { serverId: await getServerId(env.DB), actorId: me.id, action: 'account.username.update', targetType: 'user', targetId: me.id, meta: { username } })
  }
  if (body.displayName !== undefined) {
    displayName = body.displayName.trim()
    if (!displayName) fail(400, 'bad_request', 'Enter a display name')
    // An unchanged name stays allowed even if an Agent has since taken a lookalike of it.
    if (memberNameKey(displayName) !== memberNameKey(me.displayName)) await assertHumanNameAvailable(env, displayName, me.id)
    await db.update(users).set({ displayName }).where(eq(users.id, me.id))
    await db.update(authUsers).set({ name: displayName, updatedAt: new Date() }).where(eq(authUsers.id, me.id)).catch(() => undefined)
    waitUntil(signalMembersChanged(env, await getServerId(env.DB)))
  }
  return { user: { ...me, displayName, username, displayUsername } }
})
