import { and, eq } from 'drizzle-orm'
import { agents, users } from '../../../../../../drizzle/schema'
import { extForMime, sniffMime } from '../../../../../../shared/mime'
import { newId, nowIso } from '../../../../../../shared/ids'
import { Permission } from '../../../../../../shared/permissions'
import { signalMembersChanged } from '../../../../../../workers/member-events'
import { cf, requireFiles, fail } from '../../../../../utils/cf'
import { getDb } from '../../../../../utils/db'
import { requireMember } from '../../../../../utils/guards'
import { writeAudit } from '../../../../../utils/messages'

const MAX_AGENT_AVATAR_BYTES = 2 * 1024 * 1024

export default defineEventHandler(async (event): Promise<{ avatarR2Key: string }> => {
  const workspaceId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const actor = await requireMember(event, workspaceId, Permission.manageWorkspace)
  const { env, waitUntil } = cf(event)
  const form = await readMultipartFormData(event)
  const file = form?.find(part => part.name === 'file' && part.data)
  if (!file?.data) fail(400, 'bad_request', 'Missing image')
  if (file.data.byteLength > MAX_AGENT_AVATAR_BYTES) fail(413, 'too_large', 'Agent avatar exceeds 2 MB')
  const mime = sniffMime(file.data, file.filename || 'avatar')
  if (!mime?.startsWith('image/')) fail(415, 'unsupported_type', 'Agent avatar must be PNG, JPEG, WebP, or GIF')

  const db = getDb(env.DB)
  const current = (await db.select({ avatarR2Key: users.avatarR2Key }).from(users)
    .innerJoin(agents, eq(agents.userId, users.id))
    .where(and(eq(users.id, agentId), eq(users.kind, 'agent')))
    .limit(1))[0]
  if (!current) fail(404, 'not_found', 'Agent not found')

  const key = `${workspaceId}/agents/${agentId}/avatar-${newId()}.${extForMime(mime)}`
  await requireFiles(env).put(key, file.data, { httpMetadata: { contentType: mime } })
  try {
    const now = nowIso()
    await db.batch([
      db.update(users).set({ avatarR2Key: key, updatedAt: now }).where(eq(users.id, agentId)),
      db.update(agents).set({ updatedAt: now }).where(eq(agents.userId, agentId)),
    ])
  }
  catch (error) {
    await requireFiles(env).delete(key)
    throw error
  }
  if (current.avatarR2Key) await requireFiles(env).delete(current.avatarR2Key)
  await writeAudit(env, {
    workspaceId,
    actorId: actor.user.id,
    action: 'agent.avatar.update',
    targetType: 'agent',
    targetId: agentId,
  })
  waitUntil(signalMembersChanged(env, workspaceId))
  return { avatarR2Key: key }
})
