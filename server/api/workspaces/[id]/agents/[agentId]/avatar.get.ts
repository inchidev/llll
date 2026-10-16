import { and, eq } from 'drizzle-orm'
import { agents, users } from '../../../../../../drizzle/schema'
import { cf, requireFiles, fail } from '../../../../../utils/cf'
import { getDb } from '../../../../../utils/db'
import { requireMember } from '../../../../../utils/guards'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  await requireMember(event, workspaceId)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select({ avatarR2Key: users.avatarR2Key }).from(users)
    .innerJoin(agents, eq(agents.userId, users.id))
    .where(and(eq(users.id, agentId), eq(users.kind, 'agent')))
    .limit(1))[0]
  if (!row?.avatarR2Key) fail(404, 'not_found', 'Agent avatar not found')
  const object = await requireFiles(env).get(row.avatarR2Key)
  if (!object) fail(404, 'not_found', 'Agent avatar blob missing')
  setHeader(event, 'Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
  setHeader(event, 'Cache-Control', 'private, max-age=3600')
  return object.body
})
