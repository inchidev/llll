import { saveProjectPolicy } from '../../../utils/project-policies'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  return { policy: await saveProjectPolicy(cf(event).env, actor.authorization, await readBody(event)) }
})
