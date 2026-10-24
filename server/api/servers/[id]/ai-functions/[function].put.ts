import { aiFunctionIdSchema, aiFunctionConfigSchema } from '../../../../../shared/ai-functions'
import { saveAiFunction } from '../../../../utils/ai-functions'
import { requireMember } from '../../../../utils/guards'
import { cf } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'

export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  const id = parseBody(aiFunctionIdSchema, getRouterParam(event, 'function'))
  const config = parseBody(aiFunctionConfigSchema, await readBody(event))
  await saveAiFunction(cf(event).env, actor.authorization, id, config)
  return { ok: true }
})
