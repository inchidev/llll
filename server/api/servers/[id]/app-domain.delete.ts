import { z } from 'zod'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { disconnectManagedAppDomain, failServerControl } from '../../../utils/server-infrastructure'
import { parseBody } from '../../../utils/validate'

const schema = z.object({ hostname: z.string().trim().min(1).max(253) })

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage the App Domain')
  try {
    const body = parseBody(schema, await readBody(event))
    return await disconnectManagedAppDomain(cf(event).env, body.hostname, getRequestURL(event).origin)
  }
  catch (error) {
    failServerControl(error)
  }
})
