import { z } from 'zod'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { parseBody } from '../../../utils/validate'
import { saveLizardConnection } from '../../../utils/lizard-connection'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  const input = parseBody(z.object({ apiKey: z.string().min(1).max(500), projectId: z.string().min(1).max(100) }).strict(), await readBody(event))
  return saveLizardConnection(env, actor.authorization, input.apiKey, input.projectId)
})
