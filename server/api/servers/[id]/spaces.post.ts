import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { createSpace } from '../../../utils/space-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  return { space: await createSpace(cf(event).env, member, await readBody(event)) }
})
