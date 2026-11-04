import { z } from 'zod'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import {
  connectManagedAppDomain,
  disconnectManagedAppDomain,
  failServerControl,
  makeManagedAppDomainPrimary,
} from '../../../../utils/server-infrastructure'
import { parseBody } from '../../../../utils/validate'

const schema = z.object({
  action: z.enum(['add', 'remove', 'primary']),
  hostname: z.string().trim().min(1).max(253),
  makePrimary: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage Server addresses')
  const body = parseBody(schema, await readBody(event))
  const { env } = cf(event)
  try {
    const fallback = getRequestURL(event).origin
    if (body.action === 'add') return await connectManagedAppDomain(env, { hostname: body.hostname, makePrimary: body.makePrimary }, fallback)
    if (body.action === 'remove') return await disconnectManagedAppDomain(env, body.hostname, fallback)
    return await makeManagedAppDomainPrimary(env, body.hostname, fallback)
  }
  catch (error) {
    failServerControl(error)
  }
})
