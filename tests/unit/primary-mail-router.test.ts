import { describe, expect, it, vi } from 'vitest'
import { receivePrimaryMailSend, routeWorkspaceEmail } from '../../workers/primary-mail-router'

function emailMessage(to = 'support@dev.example.com') {
  return {
    from: 'person@example.net',
    to,
    raw: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('mail')); controller.close() } }),
    setReject: vi.fn(),
  }
}

describe('primary workspace mail routing', () => {
  it('proxies a secondary domain through its private service binding', async () => {
    const message = emailMessage()
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://llll-workspace.internal/.llll/mail/inbound')
      expect(request.headers.get('Authorization')).toBe('Bearer route-secret')
      expect(request.headers.get('X-L4-Mail-To')).toBe('support@dev.example.com')
      return new Response(null, { status: 202 })
    })
    const env = {
      LLLL_MAIL_ROUTES: JSON.stringify([{ domain: 'dev.example.com', serviceBinding: 'ROUTE_DEV', tokenBinding: 'TOKEN_DEV' }]),
      ROUTE_DEV: { fetch },
      TOKEN_DEV: 'route-secret',
    } as never

    await routeWorkspaceEmail(message as never, env)
    expect(fetch).toHaveBeenCalledOnce()
    expect(message.setReject).not.toHaveBeenCalled()
  })

  it('rejects recipient domains not owned by a workspace', async () => {
    const message = emailMessage('support@unknown.example.com')
    await routeWorkspaceEmail(message as never, { LLLL_PRIMARY: 'true' } as never)
    expect(message.setReject).toHaveBeenCalledWith('Unknown L4 mail domain')
  })

  it('lets a secondary send only from its registered domain', async () => {
    const send = vi.fn(async () => ({ messageId: 'sent-1' }))
    const env = {
      LLLL_PRIMARY: 'true',
      LLLL_MAIL_ROUTES: JSON.stringify([{ domain: 'dev.example.com', serviceBinding: 'ROUTE_DEV', tokenBinding: 'TOKEN_DEV' }]),
      TOKEN_DEV: 'route-secret',
      MAIL_EMAIL: { send },
    } as never
    const request = new Request('https://primary.example.com/.llll/mail/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer route-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { email: 'support@dev.example.com', name: 'Support' }, to: ['person@example.net'], subject: 'Hello', text: 'World' }),
    })

    const response = await receivePrimaryMailSend(request, env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ messageId: 'sent-1' })
    expect(send).toHaveBeenCalledOnce()
  })

  it('rejects a valid route token used for another sender domain', async () => {
    const env = {
      LLLL_PRIMARY: 'true',
      LLLL_MAIL_ROUTES: JSON.stringify([{ domain: 'dev.example.com', serviceBinding: 'ROUTE_DEV', tokenBinding: 'TOKEN_DEV' }]),
      TOKEN_DEV: 'route-secret',
      MAIL_EMAIL: { send: vi.fn() },
    } as never
    const request = new Request('https://primary.example.com/.llll/mail/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer route-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'support@other.example.com', to: 'person@example.net', subject: 'Nope' }),
    })

    const response = await receivePrimaryMailSend(request, env)
    expect(response.status).toBe(403)
  })
})
