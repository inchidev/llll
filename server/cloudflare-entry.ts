import { fileStorage } from '../shared/file-storage'
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
import { AGENT_GATEWAY_PATH, agentGateway } from './utils/agent-gateway'
import { receiveMailGatewayRequest } from '../workers/mail-gateway-ingress'
import { renewCloudflareAccess } from './utils/cloudflare-account-access'
import { requestTiming, timingRequested } from './utils/request-timing'
import { serverStartupSettled } from './utils/server-startup'
import { cloudRelay } from './utils/cloud-relay'
import { pruneRelayRequests } from './utils/cloud-partner'

export { ChannelDurableObject } from '../workers/channel-do'
export { ServerDurableObject } from '../workers/server-do'
export { RateLimitDurableObject } from '../workers/rate-limit-do'
export { NotificationDurableObject } from '../workers/notification-do'
export { L4Agent } from '../workers/llll-agent'
export { AgentRunDurableObject } from '../workers/agent-run-do'
export { AgentScheduleDurableObject } from '../workers/agent-schedule-do'
export { PortalDurableObject } from '../workers/portal-do'
export { AgentComputeDurableObject } from '../workers/agent-compute'
export { AgentOutbound } from '../workers/agent-outbound'

const nitroApp = useNitroApp()
const TASK_RECORDING_PATH = /^\/api\/(?:tasks\/[^/]+\/recording|recordings)$/
const REQUEST_STALL_LOG_MS = 90_000

export default {
  async fetch(request: Request, env: L4Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const gateway = url.pathname.match(AGENT_GATEWAY_PATH)
    if (gateway) return agentGateway(request, env, gateway[1]!, gateway[2]!, promise => context.waitUntil(promise))
    if (url.pathname === '/.llll/mail/inbound') return receiveMailGatewayRequest(request, env)
    const relayed = await cloudRelay(request, env, url.pathname, runScheduled, promise => context.waitUntil(promise))
    if (relayed) return relayed
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
    // A recording is larger than a Worker should hold: its route streams `request.body` to storage itself.
    if (request.method !== 'GET' && request.method !== 'HEAD' && !(request.method === 'POST' && TASK_RECORDING_PATH.test(url.pathname))) {
      const ab = await request.arrayBuffer()
      if (ab.byteLength) body = Buffer.from(ab)
    }

    // Opt-in measurement, per request on Previews: counts can reveal which branch a request took.
    const timing = timingRequested(env, request) ? requestTiming(env) : null
    // A request still unanswered after this long says where it waits, for the Worker logs. Model-backed
    // requests (transcription, avatars, a Factory call waiting on a Node) take up to a minute by design.
    const stall = setTimeout(() => console.warn('request.stalled', { method: request.method, path: url.pathname, startupSettled: serverStartupSettled(env.DB) }), REQUEST_STALL_LOG_MS)
    const response = await nitroApp.localFetch(url.pathname + url.search, {
      context: {
        waitUntil: (p: Promise<unknown>) => context.waitUntil(p),
        _platform: {
          cf: request.cf,
          cloudflare: { request, env: timing?.env ?? env, context, url },
        },
      },
      host: url.host,
      protocol: url.protocol,
      method: request.method,
      headers: request.headers,
      body,
    } as Parameters<typeof nitroApp.localFetch>[1]).finally(() => clearTimeout(stall))
    // A WebSocket upgrade keeps its own Response.
    if (!timing || response.status === 101) return response
    const timed = new Response(response.body, response)
    timed.headers.append('Server-Timing', timing.header())
    console.log('request.timing', { method: request.method, path: url.pathname, status: response.status, ...timing.summary() })
    return timed
  },
  async email(message: ForwardableEmailMessage, env: L4Env): Promise<void> {
    await routeServerEmail(message, env)
  },
  async scheduled(_controller: ScheduledController, env: L4Env, _context: ExecutionContext): Promise<void> {
    await runScheduled(env)
  },
}

/** The weekly work: the relay's old answers, Access renewal, then a backup. L4 Cloud runs it through the relay when no Cron Trigger fires. */
async function runScheduled(env: L4Env): Promise<void> {
  // The relay's answers to partner requests are kept for a day, so that a repeated request does nothing twice.
  await pruneRelayRequests(env).catch(error => console.warn('cloud-relay.prune_failed', { error: error instanceof Error ? error.message : String(error) }))
  // A renewal failure must not skip the backup; Settings shows when access needs reconnecting.
  try { await renewCloudflareAccess(env) }
  catch (error) { console.warn('cloudflare.access.renew_failed', { code: (error as { data?: { error?: { code?: string } } })?.data?.error?.code ?? 'unknown' }) }
  if (env.BACKUPS && (env.FILES || env.TICKETS)) {
    const createdAt = new Date().toISOString()
    await uploadBackupToR2(env.BACKUPS, `servers/${await getServerId(env.DB)}/${createdAt.replaceAll(':', '-')}.tar`, createStorageBackup(env.DB, fileStorage(env), createdAt, version))
  }
}

export { FactoryComputeDurableObject } from '../workers/factory-compute'
export { BoxOutbound } from '../workers/factory-outbound'
