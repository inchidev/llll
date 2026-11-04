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

  it.each(['mail', 'auth'])('cleans all display names and control characters before the %s binding', async kind => {
    const send = vi.fn(async () => ({ messageId: 'ok' }))
    const address = { email: 'person@example.net', name: 'Person\r\nBcc: someone\u0000\u007f' }
    await (kind === 'auth' ? sendAuthEmail : sendServerEmail)({ EMAIL: { send }, MAIL_EMAIL: { send } } as never, {
      ...message, from: address, to: [address], cc: address, bcc: [address], replyTo: address, subject: 'Subject\t\u0000\u007fNext',
    })
    const cleaned = { email: address.email, name: 'Person Bcc: someone' }
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: cleaned, to: [cleaned], cc: cleaned, bcc: [cleaned], replyTo: cleaned, subject: 'Subject Next' }))
    await expect(sendServerEmail({ MAIL_EMAIL: { send } } as never, { ...message, to: 'victim@example.net\r\nBcc: other@example.net' })).rejects.toThrow('control characters')
    expect(send).toHaveBeenCalledTimes(1)
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

describe('attachments and HTML on every transport', () => {
  const file = { filename: 'invoice\r\n.pdf', type: 'Application/PDF', content: Buffer.from('%PDF-1.7').toString('base64'), disposition: 'attachment' as const }
  const rich = { ...message, html: '<p>World</p>', attachments: [file] }
  const expected = { filename: 'invoice .pdf', type: 'application/pdf', content: file.content, disposition: 'attachment' }

  it('passes base64 files and both bodies to the Email binding', async () => {
    const send = vi.fn(async () => ({ messageId: 'ok' }))
    await sendServerEmail({ MAIL_EMAIL: { send } } as never, rich)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'World', html: '<p>World</p>', attachments: [expected] }))
  })

  it('sends attachments in the Email Sending REST body', async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { delivered: ['person@example.net'], queued: [] } }))
    vi.stubGlobal('fetch', fetcher)
    await sendServerEmail({ CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 't'.repeat(32) } as never, rich)
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ text: 'World', html: '<p>World</p>', attachments: [expected] })
  })

  it.each([
    ['HTTP gateway', { MAIL_GATEWAY_URL: 'https://mail.example.com/send', MAIL_GATEWAY_TOKEN: 'token' }],
    ['SMTP gateway', { SMTP_GATEWAY_URL: 'https://smtp.example.com/send', SMTP_GATEWAY_TOKEN: 'token' }],
  ])('sends attachments in the %s JSON', async (_name, env) => {
    const fetcher = vi.fn(async () => Response.json({ messageId: 'gateway-message' }))
    vi.stubGlobal('fetch', fetcher)
    await sendServerEmail(env as never, rich)
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ html: '<p>World</p>', attachments: [expected] })
  })

  it('refuses a malformed type or content before any transport sees it', async () => {
    const send = vi.fn(async () => ({ messageId: 'ok' }))
    await expect(sendServerEmail({ MAIL_EMAIL: { send } } as never, { ...message, attachments: [{ ...file, type: 'text/html\r\nX: y' }] })).rejects.toThrow('type')
    await expect(sendServerEmail({ MAIL_EMAIL: { send } } as never, { ...message, attachments: [{ ...file, content: 'not base64!' }] })).rejects.toThrow('base64')
    expect(send).not.toHaveBeenCalled()
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
