import { toWebRequest } from 'h3'
import { cf } from '../../../utils/cf'
import { computeSourceCapability } from '../../../utils/compute-nodes'
import { giteaSourceFetch } from '../../../utils/gitea'
import { artifactsTransport } from '../../../utils/factory-artifacts'
import { leasedBox, sameCapability } from '../../../utils/factory-boxes'
import type { RunEnvironment } from '../../../../shared/code-environments'

/** Read-only Git transport for a Compute Node fetching a Gitea repository for a box's first start. The bearer
 * capability is bound to the box and the lease its Node holds; the Gitea token stays on this Server. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event)
  const match = /^([a-f0-9-]{36})\.git(\/info\/refs|\/git-upload-pack)$/u.exec(getRouterParam(event, 'path') ?? '')
  if (!match) return new Response('Not found', { status: 404 })
  const [, boxId, suffix] = match as unknown as [string, string, string]
  const presented = getHeader(event, 'Authorization')?.replace(/^Bearer /u, '') ?? ''
  const box = await env.DB.prepare('SELECT id,lease_token AS leaseToken FROM factory_boxes WHERE id=? AND lease_token IS NOT NULL').bind(boxId).first<{ id: string; leaseToken: string }>()
  const leased = box && sameCapability(presented, await computeSourceCapability(env, box.id, box.leaseToken)) ? await leasedBox(env, box.id, box.leaseToken) : null
  if (!leased) return new Response('Source capability expired', { status: 403 })
  const environment = JSON.parse(leased.environmentJson) as RunEnvironment
  if (environment.provider === 'artifacts') return artifactsTransport(env, environment, suffix, toWebRequest(event), { service: 'git-upload-pack' })
  if (environment.provider !== 'gitea' || !environment.gitConnectionId) return new Response('Source capability denied', { status: 403 })
  return giteaSourceFetch(env, environment.gitConnectionId, environment.sourceRepo, suffix, toWebRequest(event))
})
