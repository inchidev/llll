import { z } from 'zod'
import { cf } from '../../../../../utils/cf'
import { requireMember } from '../../../../../utils/guards'
import { setSpaceSuspended } from '../../../../../utils/space-service'
import { parseBody } from '../../../../../utils/validate'

const bodySchema = z.object({ suspended: z.boolean() }).strict()

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  const { suspended } = parseBody(bodySchema, await readBody(event))
  return { space: await setSpaceSuspended(cf(event).env, member, getRouterParam(event, 'spaceId')!, suspended) }
})
