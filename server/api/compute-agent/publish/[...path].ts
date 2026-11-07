import { toWebRequest } from 'h3'
import { cf } from '../../../utils/cf'
import { giteaPush } from '../../../utils/gitea'
import { leaseCapability, sameCapability } from '../../../utils/factory-boxes'
import { nowIso } from '../../../../shared/ids'
import type { RunEnvironment } from '../../../../shared/code-environments'

/**
 * Git push transport for a VPS Node publishing a box's approved commit to Gitea. The bearer capability is
 * bound to the approval, while its push is under way, and to the box's lease; this Server reads the push's
 * commands and forwards only `<old> <approved sha> refs/heads/l4-agent/<box>`, adding the Gitea token itself.
 */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event)
  const match = /^([a-f0-9-]{36})\.git(\/info\/refs|\/git-receive-pack)$/u.exec(getRouterParam(event, 'path') ?? '')
  if (!match) return new Response('Not found', { status: 404 })
  const [, approvalId, suffix] = match as unknown as [string, string, string]
  const presented = getHeader(event, 'Authorization')?.replace(/^Bearer /u, '') ?? ''
  const row = await env.DB.prepare(`SELECT a.request_json AS requestJson,b.id AS boxId,b.lease_token AS leaseToken,b.environment_json AS environmentJson FROM factory_approvals a JOIN factory_boxes b ON b.id=a.box_id
    WHERE a.id=? AND a.kind='publish' AND a.status='publishing' AND a.expires_at>? AND b.lease_token IS NOT NULL AND b.lease_until>?`).bind(approvalId, nowIso(), nowIso())
    .first<{ requestJson: string; boxId: string; leaseToken: string; environmentJson: string }>()
  if (!row || !sameCapability(presented, await leaseCapability(env, 'compute-publish', approvalId, row.leaseToken))) return new Response('Publish capability expired', { status: 403 })
  const environment = JSON.parse(row.environmentJson) as RunEnvironment
  if (environment.provider !== 'gitea' || !environment.gitConnectionId) return new Response('Publish capability denied', { status: 403 })
  const request = JSON.parse(row.requestJson) as { sha: string; ref: string }
  return giteaPush(env, environment.gitConnectionId, environment.sourceRepo, suffix, toWebRequest(event), { ref: `refs/heads/${request.ref}`, sha: request.sha })
})
