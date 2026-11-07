import { toWebRequest } from 'h3'
import { nowIso } from '../../../../shared/ids'
import { cf } from '../../../utils/cf'
import { computeSourceCapability } from '../../../utils/compute-nodes'
import { actionColumns, authorizeFactoryAction, type ActionRow } from '../../../utils/factory-actions'
import { giteaSourceFetch } from '../../../utils/gitea'
import { leasedBox } from '../../../utils/factory-boxes'
import type { RunEnvironment } from '../../../../shared/code-environments'

/** Read-only Git transport for a Compute Node fetching a Gitea repository for a box's first start, or for
 * a bootstrap of the per-operation protocol. The bearer capability is bound to that box or bootstrap and
 * its lease; the Gitea token stays on this Server. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event)
  const match = /^([a-f0-9-]{36})\.git(\/info\/refs|\/git-upload-pack)$/u.exec(getRouterParam(event, 'path') ?? '')
  if (!match) return new Response('Not found', { status: 404 })
  const [, actionId, suffix] = match as unknown as [string, string, string]
  const presented = getHeader(event, 'Authorization')?.replace(/^Bearer /u, '') ?? ''
  const same = (expected: string) => {
    let difference = presented.length ^ 64
    for (let index = 0; index < 64; index++) difference |= (presented.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0)
    return Boolean(expected) && !difference
  }
  // A box's first start: the capability is bound to the box and the lease its Node holds.
  const box = await env.DB.prepare("SELECT id,lease_token AS leaseToken FROM factory_boxes WHERE id=? AND lease_token IS NOT NULL").bind(actionId).first<{ id: string; leaseToken: string }>()
  if (box) {
    const leased = same(await computeSourceCapability(env, box.id, box.leaseToken)) ? await leasedBox(env, box.id, box.leaseToken) : null
    if (!leased) return new Response('Source capability expired', { status: 403 })
    const environment = JSON.parse(leased.environmentJson) as RunEnvironment
    if (environment.provider !== 'gitea' || !environment.gitConnectionId) return new Response('Source capability denied', { status: 403 })
    return giteaSourceFetch(env, environment.gitConnectionId, environment.sourceRepo, suffix, toWebRequest(event))
  }
  const row = await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE id=? AND status='executing' AND lease_until>? AND expires_at>?`).bind(actionId, nowIso(), nowIso()).first<ActionRow>()
  const expected = row?.leaseToken ? await computeSourceCapability(env, row.id, row.leaseToken) : ''
  if (!row || !same(expected)) return new Response('Source capability expired', { status: 403 })
  let context
  try { context = await authorizeFactoryAction(env, row) } catch { return new Response('Operation revoked', { status: 403 }) }
  if (context.request.operation !== 'bootstrap' || context.environment.provider !== 'gitea') return new Response('Source capability denied', { status: 403 })
  return giteaSourceFetch(env, context.environment.gitConnectionId, context.environment.sourceRepo, suffix, toWebRequest(event))
})
