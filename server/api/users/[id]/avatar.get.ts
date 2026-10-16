import { eq } from 'drizzle-orm'
import { users } from '../../../../drizzle/schema'
import { isStoredAvatarKey } from '../../../../shared/avatar'
import { WORKSPACE_ID } from '../../../../shared/ids'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event) => {
  const userId = getRouterParam(event, 'id')!
  await requireMember(event, WORKSPACE_ID)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select({ avatarR2Key: users.avatarR2Key }).from(users)
    .where(eq(users.id, userId)).limit(1))[0]
  if (!isStoredAvatarKey(row?.avatarR2Key)) fail(404, 'not_found', 'Avatar not found')
  const object = await requireFiles(env).get(row.avatarR2Key)
  if (!object) fail(404, 'not_found', 'Avatar blob missing')
  setHeader(event, 'Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
  // URLs carry the object key as a version, so a new upload never reuses a cached image.
  setHeader(event, 'Cache-Control', 'private, max-age=86400')
  return object.body
})
