import { WorkerEntrypoint } from 'cloudflare:workers'
import type { L4Env } from './env'
import { agentGateway } from '../server/utils/agent-gateway'

export class AgentOutbound extends WorkerEntrypoint<L4Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!this.env.PUBLIC_ORIGIN) return new Response('Server gateway unavailable', { status: 503 })
    const target = new URL(this.env.PUBLIC_ORIGIN)
    const gateway = url.pathname.match(/^\/api\/agent-runs\/([0-9a-f-]{36})\/gateway\/(v1\/chat\/completions|tools|repository\/archive|files)$/u)
    if (url.protocol !== 'http:' || url.hostname !== target.hostname || url.port || url.search
      || !gateway) {
      return new Response('Destination is not granted', { status: 403 })
    }
    // Stay inside the Server binding. Public self-fetch is neither needed nor
    // reliable for a Worker that intercepts its own container's callbacks.
    return agentGateway(request, this.env, gateway[1]!, gateway[2]!, promise => this.ctx.waitUntil(promise))
  }
}
