import { getServerId } from '../shared/server-id'
import type { L4Env } from './env'
import { ChannelDurableObject } from './channel-do'
import { ServerDurableObject } from './server-do'
import { RateLimitDurableObject } from './rate-limit-do'
import { NotificationDurableObject } from './notification-do'
import { L4Agent } from './llll-agent'
import { receiveMailGatewayRequest } from './mail-gateway-ingress'
import { routeServerEmail } from './server-mail-router'
export { AgentRunDurableObject } from './agent-run-do'
export { AgentScheduleDurableObject } from './agent-schedule-do'
export { AgentComputeDurableObject } from './agent-compute'
export { AgentOutbound } from './agent-outbound'

export { ChannelDurableObject, ServerDurableObject, RateLimitDurableObject, NotificationDurableObject, L4Agent }

export default {
  async fetch(request: Request, env: L4Env): Promise<Response> {
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
    return new Response('llll durable objects', { status: 200 })
  },
  async email(message: ForwardableEmailMessage, env: L4Env): Promise<void> {
    await routeServerEmail(message, env)
  },
}
