import { z } from 'zod'
import { cf, fail } from '../../../../utils/cf'
import { emptyLiveFiles } from '../../../../utils/installation-management'

const claimSchema = z.string().regex(/^[0-9a-f]{64}$/u)

export default defineEventHandler(async (event): Promise<{ ok: true, deletedObjects: number }> => {
  const workspaceId = getRouterParam(event, 'id')!
  const authorization = getHeader(event, 'authorization') || ''
  const claim = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  const parsed = claimSchema.safeParse(claim)
  if (!parsed.success) fail(401, 'invalid_deletion_claim', 'Server deletion authorization is invalid or expired')

  const { env } = cf(event)
  const key = `server-deletion:${parsed.data}`
  const stored = await env.TICKETS.get(key, 'json') as { workspaceId?: string, origin?: string } | null
  if (!stored || stored.workspaceId !== workspaceId) {
    fail(401, 'invalid_deletion_claim', 'Server deletion authorization is invalid or expired')
  }
  const expectedOrigin = typeof stored.origin === 'string' ? new URL(stored.origin).origin : ''
  if (!expectedOrigin || expectedOrigin !== getRequestURL(event).origin) {
    fail(403, 'deletion_origin_mismatch', 'Server deletion authorization does not match this installation')
  }

  await env.TICKETS.delete(key)
  const deletedObjects = env.FILES ? await emptyLiveFiles(env.FILES) : 0
  return { ok: true, deletedObjects }
})
