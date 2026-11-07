import { WorkerEntrypoint } from 'cloudflare:workers'
import type { L4Env } from './env'
import type { RunEnvironment } from '../shared/code-environments'
import { AGENT_GATEWAY_PATH, agentGateway } from '../server/utils/agent-gateway'
import { leasedCloudBox } from '../server/utils/factory-boxes'
import { giteaRemote, giteaSourceFetch } from '../server/utils/gitea'

/**
 * What one Cloudflare box may reach, set by its Durable Object. The lease is checked against the Server's
 * factory_boxes on every request, so a box that lost it reaches nothing, whatever the props still say.
 */
export type BoxEgress = { boxId: string; lease: string
  /** The Task's own Artifacts repository, with a short token, while a trusted helper restores or checkpoints it. */
  storage?: { remote: string; token: string; write: boolean }
  /** The original repository's pinned source, read once while the box's first checkout is cloned. */
  source?: { remote: string; token: string } }

/** A Git smart-HTTP request under `remote` for one service only: its refs advertisement or the service itself. */
function gitService(url: URL, request: Request, remote: URL, service: 'git-upload-pack' | 'git-receive-pack') {
  if (url.origin !== remote.origin || !url.pathname.startsWith(remote.pathname)) return null
  const suffix = url.pathname.slice(remote.pathname.length)
  const allowed = request.method === 'GET' && suffix === '/info/refs' && url.searchParams.get('service') === service
    || request.method === 'POST' && suffix === `/${service}` && !url.search
  return allowed ? suffix : null
}

/**
 * The box's only way out. Credentials are added here, never inside the box: the box holds only its Run's
 * gateway capability, and every other destination is refused.
 */
export class BoxOutbound extends WorkerEntrypoint<L4Env, BoxEgress> {
  override async fetch(request: Request): Promise<Response> {
    const grant = this.ctx.props
    const box = await leasedCloudBox(this.env, grant.boxId, grant.lease)
    if (!box) return new Response('Box authorization expired', { status: 403 })
    const url = new URL(request.url), headers = new Headers(request.headers)
    headers.delete('cookie')
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return new Response('HTTPS destination required', { status: 403 })

    // The Server's gateway, served inside this Worker as the Run's Durable Object serves embedded Pi: a
    // request to the public address can be routed elsewhere, such as a Preview's parent Worker.
    const servers = [this.env.AGENT_CALLBACK_ORIGIN, this.env.PUBLIC_ORIGIN].flatMap(origin => { try { return origin ? [new URL(origin).hostname] : [] } catch { return [] } })
    const gateway = servers.includes(url.hostname) && !url.search ? url.pathname.match(AGENT_GATEWAY_PATH) : null
    if (gateway) {
      // Only a Run of this box's Task, Agent and initiator; the gateway itself checks the Run's capability.
      const own = await this.env.DB.prepare('SELECT 1 FROM agent_runs WHERE id=? AND task_id=? AND agent_id=? AND initiated_by=?').bind(gateway[1]!, box.taskId, box.agentId, box.initiatedBy).first()
      if (!own) return new Response('Run is not this box’s', { status: 403 })
      return agentGateway(new Request(url, { method: request.method, headers, body: request.body, redirect: 'manual' }), this.env, gateway[1]!, gateway[2]!, promise => this.ctx.waitUntil(promise))
    }

    headers.delete('authorization')
    if (grant.storage) {
      const remote = new URL(grant.storage.remote)
      if (gitService(url, request, remote, grant.storage.write ? 'git-receive-pack' : 'git-upload-pack') !== null) {
        headers.set('authorization', `Bearer ${grant.storage.token}`)
        return this.forward(url, request, headers)
      }
    }
    if (grant.source) {
      const remote = new URL(grant.source.remote)
      const suffix = gitService(url, request, remote, 'git-upload-pack')
      if (suffix !== null) {
        const environment = JSON.parse(box.environmentJson) as RunEnvironment
        if (environment.provider === 'gitea') {
          if (remote.href !== await giteaRemote(this.env, environment.gitConnectionId, environment.sourceRepo)) return new Response('Repository capability denied', { status: 403 })
          return giteaSourceFetch(this.env, environment.gitConnectionId, environment.sourceRepo, suffix, request)
        }
        if (remote.href !== `https://github.com/${environment.sourceRepo}.git`) return new Response('Repository capability denied', { status: 403 })
        headers.set('authorization', 'Basic ' + btoa(`x-access-token:${grant.source.token}`))
        return this.forward(url, request, headers)
      }
    }
    // A push of the Task's branch to the original repository (item 5) and package registries, Project hosts
    // and open windows (item 6) are checked here, each against the Server's state for this box.
    return new Response('Destination is not open for this box', { status: 403 })
  }

  private async forward(url: URL, request: Request, headers: Headers) {
    const response = await fetch(new Request(url, { method: request.method, headers, body: request.body, redirect: 'manual', signal: AbortSignal.timeout(120000) }))
    // A redirect never forwards a credential or leaves the granted destination.
    if (response.status >= 300 && response.status < 400) return new Response('Redirect denied', { status: 502 })
    return response
  }
}
