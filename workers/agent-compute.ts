import type {} from '../types/agent-exports'
import { DurableObject } from 'cloudflare:workers'
import type { L4Env } from './env'

/** Optional Cloudflare adapter for the same Pi HTTP image used by the VPS Runner. */
export class AgentComputeDurableObject extends DurableObject<L4Env> {
  private starting?: Promise<void>

  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container
    if (!container) return new Response('Container binding unavailable', { status: 503 })
    const url = new URL(request.url)
    const token = request.headers.get('x-run-capability')
    if (!token || !/^[0-9a-f]{64}$/u.test(token)) return new Response('Invalid capability', { status: 403 })
    if (url.pathname === '/lifecycle' && request.method === 'DELETE') {
      await this.starting
      if (container.running) await container.destroy()
      return new Response(null, { status: 204 })
    }
    if (!container.running) {
      this.starting ??= (async () => {
        // The coordinator persists transcript and results outside this filesystem.
        // No arbitrary public egress: only the Server's gateway is intercepted.
        const origin = new URL(this.env.PUBLIC_ORIGIN!)
        const gateway = this.ctx.exports.AgentOutbound({ props: { origin: origin.origin } })
        await container.interceptOutboundHttp(origin.hostname, gateway)
        // This HTTP hop stays inside Cloudflare's encrypted interception network.
        // The trusted outbound Worker calls the Server gateway directly.
        container.start({ image: container.images.pi, instance: 'standard-1', enableInternet: false,
          env: { LLLL_RUN_TOKEN: token } })
        for (let attempt = 0; attempt < 60; attempt++) {
          try {
            const health = await container.getTcpPort(8080).fetch('http://container/health', { headers: { Authorization: `Bearer ${token}` } })
            if (health.ok) return
          } catch { /* Wait for readiness without blocking incoming cancellation. */ }
          await scheduler.wait(250)
        }
        throw new Error('Pi container startup timed out')
      })().finally(() => { this.starting = undefined })
      await this.starting
    }
    await container.setInactivityTimeout(60_000)
    url.hostname = 'container'
    url.protocol = 'http:'
    const headers = new Headers(request.headers)
    headers.delete('x-run-capability')
    headers.set('Authorization', `Bearer ${token}`)
    return container.getTcpPort(8080).fetch(new Request(url, { method: request.method, headers, body: request.body }))
  }
}
