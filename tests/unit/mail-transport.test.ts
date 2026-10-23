import { afterEach, describe, expect, it, vi } from 'vitest'
import { serverCapabilities } from '../../workers/server-capabilities'
import { requireMailSendLimit } from '../../server/utils/server-mail'
import { receiveMailGatewayRequest, secureTokenEqual } from '../../workers/mail-gateway-ingress'
import { authEmailAvailable, sendAuthEmail, sendServerEmail, serverEmailAvailable } from '../../workers/mail-transport'

afterEach(() => vi.unstubAllGlobals())

const message = {
  from: { email: 'support@dev1.example.com', name: 'Support' },
  to: ['person@example.net'],
  subject: 'Hello',
  text: 'World',
}

describe('server mail transport', () => {
  it('keeps reply headers and uses REST address and reply_to field names', async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { delivered: ['person@example.net'], queued: [], permanent_bounces: [] } }))
    vi.stubGlobal('fetch', fetcher)
    await sendServerEmail({ CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 't'.repeat(32) } as never, {
      ...message, replyTo: { email: 'replies@example.com', name: 'Replies' }, headers: { 'In-Reply-To': '<first@example.net>', References: '<first@example.net>' },
    })
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({
      from: { address: message.from.email, name: 'Support' }, reply_to: { address: 'replies@example.com', name: 'Replies' },
      headers: { 'In-Reply-To': '<first@example.net>', References: '<first@example.net>' },
    })
  })

  it('does not report all-bounced REST recipients as a successful send', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result: { delivered: [], queued: [], permanent_bounces: ['person@example.net'] } })))
    await expect(sendServerEmail({ CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 't'.repeat(32) } as never, message)).rejects.toThrow()
  })

  it('removes subject newlines before any transport sees them', async () => {
    const send = vi.fn(async () => ({ messageId: 'ok' }))
    await sendServerEmail({ MAIL_EMAIL: { send } } as never, { ...message, subject: 'Hello\r\nBcc: victim@example.net' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Hello Bcc: victim@example.net' }))
  })

  it('does not advertise mailbox sending when only the auth binding exists', () => {
    const env = { EMAIL: { send: vi.fn() } } as never
    expect(authEmailAvailable(env)).toBe(true)
    expect(serverEmailAvailable(env)).toBe(false)
    expect(serverCapabilities(env)).toMatchObject({ emailOutbound: false, emailProvider: null })
  })

  it('limits external sends and fails closed when its limiter is unavailable', async () => {
    const take = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('unavailable'))
    const getByName = vi.fn(() => ({ take }))
    const env = { RATE_LIMIT_DO: { getByName } } as never
    await expect(requireMailSendLimit(env, 'support', 'sender')).resolves.toBeUndefined()
    expect(getByName).toHaveBeenCalledWith('mail:support:sender')
    expect(take).toHaveBeenCalledWith(10, 60_000)
    await expect(requireMailSendLimit(env, 'support', 'sender')).rejects.toMatchObject({ statusCode: 429 })
    await expect(requireMailSendLimit(env, 'support', 'sender')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('uses a send binding before the authenticated gateway', async () => {
    const direct = { send: vi.fn(async () => ({ messageId: 'direct-message' })) }
    const fetch = vi.fn(async () => Response.json({ messageId: 'gateway-message' }))
    const env = { MAIL_GATEWAY: { fetch }, MAIL_GATEWAY_TOKEN: 'server-token', MAIL_EMAIL: direct } as never

    await expect(sendServerEmail(env, message)).resolves.toEqual({ messageId: 'direct-message' })
    expect(fetch).not.toHaveBeenCalled()
    expect(direct.send).toHaveBeenCalledWith(message)
    expect(serverEmailAvailable(env)).toBe(true)
  })

  it('retains the direct binding adapter for manual deployments', async () => {
    const send = vi.fn(async () => ({ messageId: 'direct-message' }))
    await expect(sendServerEmail({ MAIL_EMAIL: { send } } as never, message)).resolves.toEqual({ messageId: 'direct-message' })
    expect(send).toHaveBeenCalledWith(message)
  })

  it('uses a dedicated auth binding before server mail', async () => {
    const authSend = vi.fn(async () => ({ messageId: 'auth-message' }))
    const serverSend = vi.fn()
    const env = { EMAIL: { send: authSend }, MAIL_EMAIL: { send: serverSend } } as never
    await expect(sendAuthEmail(env, message)).resolves.toEqual({ messageId: 'auth-message' })
    expect(serverSend).not.toHaveBeenCalled()
    expect(authEmailAvailable(env)).toBe(true)
  })

  it('surfaces a bounded gateway error', async () => {
    const env = {
      MAIL_GATEWAY_TOKEN: 'server-token',
      MAIL_GATEWAY: { fetch: async () => Response.json({ error: 'Sender domain is not registered' }, { status: 403 }) },
    } as never
    await expect(sendServerEmail(env, message)).rejects.toThrow('Sender domain is not registered')
  })
})

describe('primary mail ingress', () => {
  it('compares ingress credentials without comparing their raw values', async () => {
    await expect(secureTokenEqual('same', 'same')).resolves.toBe(true)
    await expect(secureTokenEqual('same', 'different')).resolves.toBe(false)
  })

  it('rejects public requests without the server credential', async () => {
    const request = new Request('https://server.example.com/.llll/mail/inbound', { method: 'POST', body: 'mail' })
    const response = await receiveMailGatewayRequest(request, { MAIL_GATEWAY_TOKEN: 'secret' } as never)
    expect(response.status).toBe(401)
  })

  it('lets the server D1 reject an unknown routed mailbox', async () => {
    const first = vi.fn(async () => null)
    const env = {
      MAIL_GATEWAY_TOKEN: 'secret',
      DB: { prepare: () => ({ bind: () => ({ first }) }) },
    } as never
    const request = new Request('https://server.example.com/.llll/mail/inbound', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'X-L4-Mail-From': 'sender@example.net',
        'X-L4-Mail-To': 'missing@server.example.com',
      },
      body: 'mail',
    })
    const response = await receiveMailGatewayRequest(request, env)
    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toBe('Unknown L4 mailbox')
  })
})
