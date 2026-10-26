import { parseBody } from '../../utils/validate'
import { toWebRequest } from 'h3'
import { z } from 'zod'
import { cf, fail } from '../../utils/cf'
import { pairComputeNode } from '../../utils/compute-nodes'
import { dockerCapabilities } from '../../../shared/software-factory'
import { readLimitedStream } from '../../../workers/inbound-email-signature'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event)
  const body = await readLimitedStream(toWebRequest(event).body, 4000)
  if (!body.ok) throw createError({ statusCode: 413 })
  let inputJson: unknown
  try { inputJson = JSON.parse(new TextDecoder().decode(body.bytes)) } catch { fail(400, 'bad_request', 'Invalid JSON input') }
  const input = parseBody(z.object({ token: z.string().regex(/^[a-f0-9]{64}$/u), capabilities: dockerCapabilities }).strict(), inputJson)
  return pairComputeNode(env, input.token, input.capabilities)
})
