import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { listSpaces } from '../../../utils/space-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  const { env } = cf(event)
  return { spaces: await listSpaces(env, member) }
})
