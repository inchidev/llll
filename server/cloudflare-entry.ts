import { getServerId } from '../shared/server-id'
import { createStorageBackup } from '../shared/storage-backup'
import { uploadBackupToR2 } from '../shared/r2-backup'
import { version } from '../package.json'
import './shims/create-task-guard'
import '#nitro-internal-pollyfills'
import { useNitroApp } from 'nitropack/runtime'
import { isPublicAssetURL } from '#nitro-internal-virtual/public-assets'
import type { L4Env } from '../workers/env'
import { routeServerEmail } from '../workers/server-mail-router'
import { receiveMailGatewayRequest } from '../workers/mail-gateway-ingress'

export { ChannelDurableObject } from '../workers/channel-do'
export { ServerDurableObject } from '../workers/server-do'
export { RateLimitDurableObject } from '../workers/rate-limit-do'
export { NotificationDurableObject } from '../workers/notification-do'
export { L4Agent, L4Think } from '../workers/llll-agent'

const nitroApp = useNitroApp()

export default {
  async fetch(request: Request, env: L4Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/.llll/mail/inbound') return receiveMailGatewayRequest(request, env)
    if (request.headers.get('Upgrade') === 'websocket') {
      const channel = url.pathname.match(/^\/ws\/channel\/([^/]+)/)
      if (channel?.[1]) {
        return env.CHANNEL_DO.getByName(`channel:${channel[1]}`).fetch(request)
      }
      const server = url.pathname.match(/^\/ws\/server\/([^/]+)/)
      if (server?.[1]) {
        if (server[1] !== await getServerId(env.DB)) return new Response('Server not found', { status: 404 })
        return env.SERVER_DO.getByName(`server:${server[1]}`).fetch(request)
      }
    }

    if (env.ASSETS && isPublicAssetURL(url.pathname)) {
      return env.ASSETS.fetch(request)
    }

    let body: Buffer | undefined
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const ab = await request.arrayBuffer()
      if (ab.byteLength) body = Buffer.from(ab)
    }

    return nitroApp.localFetch(url.pathname + url.search, {
      context: {
        waitUntil: (p: Promise<unknown>) => context.waitUntil(p),
        _platform: {
          cf: request.cf,
          cloudflare: { request, env, context, url },
        },
      },
      host: url.host,
      protocol: url.protocol,
      method: request.method,
      headers: request.headers,
      body,
    } as Parameters<typeof nitroApp.localFetch>[1])
  },
  async email(message: ForwardableEmailMessage, env: L4Env): Promise<void> {
    await routeServerEmail(message, env)
  },
  async scheduled(_controller: ScheduledController, env: L4Env, _context: ExecutionContext): Promise<void> {
    if (env.BACKUPS && env.FILES) {
      const createdAt = new Date().toISOString()
      await uploadBackupToR2(env.BACKUPS, `servers/${await getServerId(env.DB)}/${createdAt.replaceAll(':', '-')}.tar`, createStorageBackup(env.DB, env.FILES, createdAt, version))
    }
  },
}
