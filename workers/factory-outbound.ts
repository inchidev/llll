import { WorkerEntrypoint } from 'cloudflare:workers'
import type { L4Env } from './env'
import { actionColumns, authorizeFactoryAction, type ActionRow } from '../server/utils/factory-actions'
import { nowIso } from '../shared/ids'
import { giteaRemote, giteaSourceFetch } from '../server/utils/gitea'

type FactoryEgress = { actionId: string; lease: string; phase: 'source' | 'restore' | 'checkpoint' | 'command'; remote?: string; token?: string }
/** Expiring per-operation capabilities stay in Workers, outside the Task VM. */
export class FactoryOutbound extends WorkerEntrypoint<L4Env, FactoryEgress> {
  override async fetch(request: Request): Promise<Response> {
    const grant = this.ctx.props
    const row = await this.env.DB.prepare(`SELECT ${actionColumns} FROM factory_actions WHERE id=? AND lease_token=? AND status='executing' AND lease_until>? AND expires_at>?`)
      .bind(grant.actionId, grant.lease, nowIso(), nowIso()).first<ActionRow>()
    if (!row) return new Response('Operation authorization expired', { status: 403 })
    let context
    try { context = await authorizeFactoryAction(this.env, row) } catch { return new Response('Operation revoked', { status: 403 }) }
    const url = new URL(request.url), headers = new Headers(request.headers)
    headers.delete('authorization'); headers.delete('cookie')
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return new Response('HTTPS destination required', { status: 403 })
    if (grant.phase === 'command') {
      if (context.request.operation !== 'exec' || !context.request.networkHosts.includes(url.hostname)) return new Response('Host was not reviewed', { status: 403 })
    } else {
      if (!grant.remote || !grant.token) return new Response('Storage capability unavailable', { status: 403 })
      const remote = new URL(grant.remote)
      const suffix = url.pathname.slice(remote.pathname.length)
      const service = url.searchParams.get('service')
      const write = grant.phase === 'checkpoint'
      if (url.origin !== remote.origin || !url.pathname.startsWith(remote.pathname)
        || !(request.method === 'GET' && suffix === '/info/refs' && service === (write ? 'git-receive-pack' : 'git-upload-pack')
          || request.method === 'POST' && suffix === (write ? '/git-receive-pack' : '/git-upload-pack') && !url.search)) return new Response('Repository capability denied', { status: 403 })
      if (grant.phase === 'source' && context.environment.provider === 'gitea') {
        if (remote.href !== await giteaRemote(this.env, context.environment.gitConnectionId, context.environment.sourceRepo)) return new Response('Repository capability denied', { status: 403 })
        return giteaSourceFetch(this.env, context.environment.gitConnectionId, context.environment.sourceRepo, suffix, request)
      }
      // Source is a single-repository read grant; private code store is one isolated Task repo.
      headers.set('authorization', grant.phase === 'source' ? 'Basic ' + btoa(`x-access-token:${grant.token}`) : `Bearer ${grant.token}`)
    }
    const response = await fetch(new Request(url, { method: request.method, headers, body: request.body, redirect: 'manual', signal: AbortSignal.timeout(120000) }))
    // A redirect never forwards storage credentials or escapes the reviewed destination.
    if (response.status >= 300 && response.status < 400) return new Response('Redirect denied', { status: 502 })
    return response
  }
}
