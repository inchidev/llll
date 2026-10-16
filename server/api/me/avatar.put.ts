import { eq } from 'drizzle-orm'
import { users } from '../../../drizzle/schema'
import { isStoredAvatarKey, MAX_AVATAR_BYTES } from '../../../shared/avatar'
import { newId, nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { extForMime, sniffMime } from '../../../shared/mime'
import { signalMembersChanged } from '../../../workers/member-events'
import { cf, requireFiles, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { requireMember } from '../../utils/guards'

export default defineEventHandler(async (event): Promise<{ avatarR2Key: string }> => {
  const { user } = await requireMember(event, WORKSPACE_ID)
  const { env, waitUntil } = cf(event)
  const form = await readMultipartFormData(event)
  const file = form?.find(part => part.name === 'file' && part.data)
  if (!file?.data) fail(400, 'bad_request', 'Missing image')
  if (file.data.byteLength > MAX_AVATAR_BYTES) fail(413, 'too_large', 'Avatar exceeds 2 MB')
  const mime = sniffMime(file.data, file.filename || 'avatar')
  if (!mime?.startsWith('image/')) fail(415, 'unsupported_type', 'Avatar must be PNG, JPEG, WebP, or GIF')

  const db = getDb(env.DB)
  const current = (await db.select({ avatarR2Key: users.avatarR2Key }).from(users)
    .where(eq(users.id, user.id)).limit(1))[0]
  if (!current) fail(404, 'not_found', 'User not found')

  const key = `${WORKSPACE_ID}/users/${user.id}/avatar-${newId()}.${extForMime(mime)}`
  await requireFiles(env).put(key, file.data, { httpMetadata: { contentType: mime } })
  try {
    await db.update(users).set({ avatarR2Key: key, updatedAt: nowIso() }).where(eq(users.id, user.id))
  }
  catch (error) {
    await requireFiles(env).delete(key)
    throw error
  }
  if (isStoredAvatarKey(current.avatarR2Key)) await requireFiles(env).delete(current.avatarR2Key)
  waitUntil(signalMembersChanged(env, WORKSPACE_ID))
  return { avatarR2Key: key }
})
