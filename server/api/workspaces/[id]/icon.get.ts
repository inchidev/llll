import { eq } from 'drizzle-orm'
import { workspace } from '../../../../drizzle/schema'
import { requireMember } from '../../../utils/guards'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  await requireMember(event, workspaceId)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select({ iconR2Key: workspace.iconR2Key }).from(workspace)
    .where(eq(workspace.id, workspaceId)).limit(1))[0]
  if (!row?.iconR2Key) fail(404, 'not_found', 'Workspace icon not found')
  const object = await requireFiles(env).get(row.iconR2Key)
  if (!object) fail(404, 'not_found', 'Workspace icon blob missing')
  setHeader(event, 'Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
  setHeader(event, 'Cache-Control', 'private, max-age=3600')
  return object.body
})
