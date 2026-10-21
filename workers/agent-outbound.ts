import { WorkerEntrypoint } from 'cloudflare:workers'
import type { L4Env } from './env'

export class AgentOutbound extends WorkerEntrypoint<L4Env, { origin: string }> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.origin !== this.ctx.props.origin || !/^\/api\/agent-runs\/[0-9a-f-]{36}\/gateway\/(v1\/chat\/completions|tools)$/u.test(url.pathname)) {
      return new Response('Destination is not granted', { status: 403 })
    }
    return fetch(request, { redirect: 'error' })
  }
}
