import { toWebRequest } from 'h3'
import { cf } from '../../../utils/cf'
import { checkpointTransport } from '../../../utils/box-checkpoints'

/**
 * Git transport for an L4 Compute box's private checkpoint repository: its daemon fetches it when the box starts on
 * a new machine and pushes `l4-state` when the box goes idle. The bearer capability is bound to the box and the
 * lease its Node holds; the Artifacts token is minted here for each request and never leaves this Server.
 */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event)
  const match = /^([a-f0-9-]{36})\.git(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/u.exec(getRouterParam(event, 'path') ?? '')
  if (!match) return new Response('Not found', { status: 404 })
  const [, boxId, suffix] = match as unknown as [string, string, string]
  return checkpointTransport(env, boxId, getHeader(event, 'Authorization')?.replace(/^Bearer /u, '') ?? '', suffix, toWebRequest(event))
})
