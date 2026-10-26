import { toWebRequest } from 'h3'
import { z } from 'zod'
import { cf } from '../../utils/cf'
import { pairComputeNode } from '../../utils/compute-nodes'
import { computeCapabilities } from '../../../shared/software-factory'
import { readLimitedStream } from '../../../workers/inbound-email-signature'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event)
  const body = await readLimitedStream(toWebRequest(event).body, 4000)
  if (!body.ok) throw createError({ statusCode: 413 })
  const input = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/u), capabilities: computeCapabilities }).strict().parse(JSON.parse(new TextDecoder().decode(body.bytes)))
  return pairComputeNode(env, input.token, input.capabilities)
})
