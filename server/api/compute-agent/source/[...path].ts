import { toWebRequest } from 'h3'
import { nowIso } from '../../../../shared/ids'
import { cf } from '../../../utils/cf'
import { computeSourceCapability } from '../../../utils/compute-nodes'
import { actionColumns, authorizeFactoryAction, type ActionRow } from '../../../utils/factory-actions'
import { giteaSourceFetch } from '../../../utils/gitea'

/** Read-only Git transport for a Compute Node bootstrapping a Gitea repository. The bearer capability
 * is bound to one executing bootstrap and its lease; the Gitea token stays on this Server. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event)
  const match = /^([a-f0-9-]{36})\.git(\/info\/refs|\/git-upload-pack)$/u.exec(getRouterParam(event, 'path') ?? '')
  if (!match) return new Response('Not found', { status: 404 })
  const [, actionId, suffix] = match as unknown as [string, string, string]
  const row = await env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE id=? AND status='executing' AND lease_until>? AND expires_at>?`).bind(actionId, nowIso(), nowIso()).first<ActionRow>()
  const presented = getHeader(event, 'Authorization')?.replace(/^Bearer /u, '') ?? ''
  const expected = row?.leaseToken ? await computeSourceCapability(env, row.id, row.leaseToken) : ''
  let difference = presented.length ^ 64
  for (let index = 0; index < 64; index++) difference |= (presented.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0)
  if (!row || !expected || difference) return new Response('Source capability expired', { status: 403 })
  let context
  try { context = await authorizeFactoryAction(env, row) } catch { return new Response('Operation revoked', { status: 403 }) }
  if (context.request.operation !== 'bootstrap' || context.environment.provider !== 'gitea') return new Response('Source capability denied', { status: 403 })
  return giteaSourceFetch(env, context.environment.gitConnectionId, context.environment.sourceRepo, suffix, toWebRequest(event))
})
