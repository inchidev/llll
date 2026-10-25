import { z } from 'zod'
import { findAgentRun } from '../../../utils/agent-run-service'
import { prepareRunPublication, decideRunPublication } from '../../../utils/run-publication'
import { requireChannelAccess } from '../../../utils/guards'
import { requireRunReader } from '../../../utils/agent-tool-security'
import { Permission } from '../../../../shared/permissions'
import { cf, fail } from '../../../utils/cf'
import { asRpc } from '../../../../workers/env'
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare') }).strict(),
  z.object({ action: z.literal('decide'), id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/u), decision: z.enum(['approve', 'reject']) }).strict(),
])
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId, Permission.sendMessages)
  requireRunReader(run, actor.user.id)
  const parsed = requestSchema.safeParse(await readBody(event))
  if (!parsed.success) fail(400, 'invalid_publication', 'Invalid publication review request')
  const input = parsed.data
  if (input.action === 'prepare') return { publication: await prepareRunPublication(env, run.id, actor.user.id) }
  if (!env.CHANNEL_DO) fail(503, 'unavailable', 'Conversation service unavailable')
  return { publication: await decideRunPublication(env, run.id, actor.user.id, input, value =>
    asRpc<{ postAgentMessage: (input: typeof value) => Promise<{ id: string; channelId: string }> }>(env.CHANNEL_DO.getByName(`channel:${run.channelId}`)).postAgentMessage(value)) }
})
