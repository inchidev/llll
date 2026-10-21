import { WorkerEntrypoint } from 'cloudflare:workers'
import type { L4Env } from './env'

export class AgentOutbound extends WorkerEntrypoint<L4Env, { origin: string }> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const target = new URL(this.ctx.props.origin)
    if (url.protocol !== 'http:' || url.hostname !== target.hostname || url.port || url.search
      || !/^\/api\/agent-runs\/[0-9a-f-]{36}\/gateway\/(v1\/chat\/completions|tools)$/u.test(url.pathname)) {
      return new Response('Destination is not granted', { status: 403 })
    }
    target.pathname = url.pathname
    return fetch(new Request(target, request), { redirect: 'error' })
  }
}
