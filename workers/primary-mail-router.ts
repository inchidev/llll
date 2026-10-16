import type { L4Env } from './env'
import { receiveWorkspaceEmail } from './mail-ingress'
import { secureTokenEqual } from './mail-gateway-ingress'
import type { WorkspaceEmailMessage } from './mail-transport'
import { workspaceMailDomains } from '../server/utils/workspace-mail'

export type PrimaryMailRoute = {
  domain: string
  serviceBinding: string
  tokenBinding: string
}

function routeConfig(env: L4Env): PrimaryMailRoute[] {
  if (!env.LLLL_MAIL_ROUTES) return []
  try {
    const value = JSON.parse(env.LLLL_MAIL_ROUTES) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is PrimaryMailRoute => Boolean(
      item
      && typeof item === 'object'
      && typeof (item as PrimaryMailRoute).domain === 'string'
      && typeof (item as PrimaryMailRoute).serviceBinding === 'string'
      && typeof (item as PrimaryMailRoute).tokenBinding === 'string',
    ))
  }
  catch {
    return []
  }
}

function dynamicBinding(env: L4Env, name: string): unknown {
  return (env as L4Env & Record<string, unknown>)[name]
}

function recipientDomain(address: string): string {
  const separator = address.lastIndexOf('@')
  return separator === -1 ? '' : address.slice(separator + 1).trim().toLowerCase()
}

function senderAddress(message: WorkspaceEmailMessage): string {
  return (typeof message.from === 'string' ? message.from : message.from.email).trim().toLowerCase()
}

/** Routes the zone catch-all inside the primary L4 Worker. */
export async function routeWorkspaceEmail(message: ForwardableEmailMessage, env: L4Env): Promise<void> {
  const domain = recipientDomain(message.to)
  if (domain && workspaceMailDomains(env).some(item => item.domain === domain)) {
    await receiveWorkspaceEmail(message, env)
    return
  }

  const route = routeConfig(env).find(item => item.domain.toLowerCase() === domain)
  const service = route && dynamicBinding(env, route.serviceBinding) as Fetcher | undefined
  const token = route && dynamicBinding(env, route.tokenBinding)
  if (!route || !service || typeof token !== 'string') {
    message.setReject('Unknown L4 mail domain')
    return
  }

  const response = await service.fetch(new Request('https://llll-workspace.internal/.llll/mail/inbound', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-L4-Mail-From': message.from,
      'X-L4-Mail-To': message.to,
    },
    body: message.raw,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' }))
  if (!response.ok) message.setReject((await response.text()).slice(0, 200) || 'Workspace rejected email')
}

/** Authenticated outbound mail endpoint hosted by the primary L4 Worker. */
export async function receivePrimaryMailSend(request: Request, env: L4Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!env.LLLL_PRIMARY || !env.MAIL_EMAIL) return new Response('Primary mail is unavailable', { status: 503 })

  const authorization = request.headers.get('Authorization') || ''
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  let authorizedDomain = ''
  for (const route of routeConfig(env)) {
    const token = dynamicBinding(env, route.tokenBinding)
    if (typeof token === 'string' && await secureTokenEqual(bearer, token)) {
      authorizedDomain = route.domain.toLowerCase()
      break
    }
  }
  if (!authorizedDomain) return new Response('Unauthorized', { status: 401 })

  const message = await request.json().catch(() => null) as WorkspaceEmailMessage | null
  if (!message?.from || !message.subject) return Response.json({ error: 'Invalid email message' }, { status: 400 })
  if (recipientDomain(senderAddress(message)) !== authorizedDomain) {
    return Response.json({ error: 'Sender domain is not registered' }, { status: 403 })
  }
  const result = await env.MAIL_EMAIL.send(message)
  return Response.json({ messageId: result.messageId })
}
