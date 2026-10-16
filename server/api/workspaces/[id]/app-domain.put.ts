import { z } from 'zod'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { connectManagedAppDomain, failInstallationControl } from '../../../utils/installation-control'
import { parseBody } from '../../../utils/validate'

const schema = z.object({
  zoneId: z.string().trim().min(1).max(64),
  hostname: z.string().trim().min(1).max(253),
})

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage the App Domain')
  try {
    return await connectManagedAppDomain(cf(event).env, parseBody(schema, await readBody(event)))
  }
  catch (error) {
    failInstallationControl(error)
  }
})
