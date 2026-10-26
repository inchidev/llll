import { toWebRequest } from 'h3'
import { cf } from '../../utils/cf'
import { computePoll, computePollSchema, requireComputeNode } from '../../utils/compute-nodes'
import { readLimitedStream } from '../../../workers/inbound-email-signature'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event), node = await requireComputeNode(env, getHeader(event, 'Authorization')?.replace(/^Bearer /u, '') ?? '')
  const body = await readLimitedStream(toWebRequest(event).body, 420000)
  if (!body.ok) throw createError({ statusCode: 413 })
  return computePoll(env, node.id, computePollSchema.parse(JSON.parse(new TextDecoder().decode(body.bytes))))
})
