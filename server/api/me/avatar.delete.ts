import { eq } from 'drizzle-orm'
import { users } from '../../../drizzle/schema'
import { isStoredAvatarKey } from '../../../shared/avatar'
import { nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { signalMembersChanged } from '../../../workers/member-events'
import { cf } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { requireMember } from '../../utils/guards'

export default defineEventHandler(async (event) => {
  const { user } = await requireMember(event, WORKSPACE_ID)
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const current = (await db.select({ avatarR2Key: users.avatarR2Key }).from(users)
    .where(eq(users.id, user.id)).limit(1))[0]
  if (!current?.avatarR2Key) return { ok: true }
  await db.update(users).set({ avatarR2Key: null, updatedAt: nowIso() }).where(eq(users.id, user.id))
  if (isStoredAvatarKey(current.avatarR2Key)) await requireFiles(env).delete(current.avatarR2Key)
  waitUntil(signalMembersChanged(env, WORKSPACE_ID))
  return { ok: true }
})
