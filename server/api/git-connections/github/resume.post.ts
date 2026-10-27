import { z } from 'zod'
import { getServerId } from '../../../../shared/server-id'
import { reopenGithubSetup } from '../../../utils/git-connections'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const input = parseBody(z.object({ state: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(), await readBody(event))
  await reopenGithubSetup(env, actor.authorization, input.state)
  return { resumed: true }
})
