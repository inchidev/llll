import '#nitro-internal-pollyfills'
import { useNitroApp } from 'nitropack/runtime'
import { isPublicAssetURL } from '#nitro-internal-virtual/public-assets'
import type { AdminEnv } from './env'
import { runMaintenance } from './utils/maintenance'

export { AdminCoordinator } from './coordinator'
export { WorkspaceControl } from './workspace-control'

const nitroApp = useNitroApp()

export default {
  async fetch(request: Request, env: AdminEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (env.ASSETS && isPublicAssetURL(url.pathname)) return env.ASSETS.fetch(request)
    ;(globalThis as { __adminEnv__?: AdminEnv }).__adminEnv__ = env

    let body: Buffer | undefined
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const buffer = await request.arrayBuffer()
      if (buffer.byteLength) body = Buffer.from(buffer)
    }
    return nitroApp.localFetch(url.pathname + url.search, {
      context: {
        waitUntil: (work: Promise<unknown>) => context.waitUntil(work),
        _platform: { cloudflare: { request, env, context, url } },
      },
      host: url.hostname,
      protocol: url.protocol,
      method: request.method,
      headers: request.headers,
      body,
    } as Parameters<typeof nitroApp.localFetch>[1])
  },
  // Awaited, not deferred: a scheduled run may take minutes when it applies an update.
  async scheduled(_controller: ScheduledController, env: AdminEnv): Promise<void> {
    await runMaintenance(env).catch(error => console.warn('Admin maintenance failed', error))
  },
}
