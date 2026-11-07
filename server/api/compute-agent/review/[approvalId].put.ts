import { toWebRequest } from 'h3'
import { cf } from '../../../utils/cf'
import { requireComputeNode } from '../../../utils/compute-nodes'
import { submitReview } from '../../../utils/factory-approvals'
import { readLimitedStream } from '../../../../workers/inbound-email-signature'

/** A VPS Node's review of a push, made from Git in a throwaway container: it goes to R2, its digest to D1. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event), node = await requireComputeNode(env, getHeader(event, 'Authorization')?.replace(/^Bearer /u, '') ?? '')
  const approvalId = getRouterParam(event, 'approvalId') ?? ''
  if (!/^[a-f0-9-]{36}$/u.test(approvalId)) throw createError({ statusCode: 404 })
  const body = await readLimitedStream(toWebRequest(event).body, 2_200_000)
  if (!body.ok) throw createError({ statusCode: 413 })
  return submitReview(env, node.id, approvalId, body.bytes)
})
