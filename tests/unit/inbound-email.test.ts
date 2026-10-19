import { createHmac, createPrivateKey, createSign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAIL_LIMITS } from '../../shared/mail'
import { forwardInboundEmail } from '../../workers/email-bridge'
import {
  acceptMailgunInbound,
  acceptPostmarkInbound,
  acceptSesInbound,
  acceptSignedInboundEmail,
  emailInboundProvider,
} from '../../workers/inbound-email'
import {
  inboundTimestampFresh,
  inboundWebhookShouldRetry,
  signInboundEmail,
  verifyInboundEmailSignature,
  verifyMailgunSignature,
} from '../../workers/inbound-email-signature'
import { ingestServerEmail } from '../../workers/mail-ingress'
import { allowedSnsCertificateUrl, allowedSnsSubscribeUrl, snsStringToSign, verifySnsMessage, type SnsMessage } from '../../workers/sns-signature'

vi.mock('../../workers/mail-ingress', () => ({
  ingestServerEmail: vi.fn(async () => ({ accepted: true })),
}))

const SECRET = 's'.repeat(32)
const POSTMARK = 'p'.repeat(32)
const MAILGUN = 'm'.repeat(40)
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:llll-inbound'
const RAW = new TextEncoder().encode('From: person@example.net\r\nTo: support@example.com\r\n\r\nHello\r\n')
const CERT = "-----BEGIN CERTIFICATE-----\nMIIDBzCCAe+gAwIBAgIUYvBzhgCzF5fk0tYVb9BsWaW2ti8wDQYJKoZIhvcNAQEL\nBQAwEzERMA8GA1UEAwwIc25zLXRlc3QwHhcNMjYxMDE0MTQ0NzMwWhcNMzYxMDEx\nMTQ0NzMwWjATMREwDwYDVQQDDAhzbnMtdGVzdDCCASIwDQYJKoZIhvcNAQEBBQAD\nggEPADCCAQoCggEBAMtO2qR3KwPsbcKfb00ZKDUPT4ctZAQTsDV+jpBVQAkcR7Bu\niRWX5PWEC/Yeu2uakoc/r6b1vaXgH4+/u7Cnfhv9qHwSfmdJmFr7T4jhGOz+XtwT\n2gdtrzRYWtTMw+X5pOwfIww2N6N7XSgF9q7+mIs7qDqeJpZ0g7+fBdGzd5wajNwX\nnM8Ez+40YYZyneFIQBxVaCe4Wn0dkQi+VItQn82RT21j+UVhNQYk2AdN7meS5VVC\nGepIUtx1swT/QTNZdqGxnCFqGusGejhGUaL0SvhsS+VAEKSJ8f3w/YgbstE+n65c\ntjzZLWW5udGL2/GdbEOvn/QlHgOXOCLvRahvbw8CAwEAAaNTMFEwHQYDVR0OBBYE\nFPNe6bn1ARUdDHN61yXs9jj5LYQBMB8GA1UdIwQYMBaAFPNe6bn1ARUdDHN61yXs\n9jj5LYQBMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAA/rHPDv\nUQ9fPwHkaaH2kujC23brYyq68ZZnRi3D0krNZVYznD7xz3HFaCc4Emw160PtUInZ\njJ0+Ag5dK/Qg3gSwWF0rMXaFgEompDQ49fRSKpHj7REFerR3c9Hg5NJDhcwzesn+\n9jTzseueh53PeQGPleePisFVFecXCLZ798O1PemUWdy7DgKh3LGpiO9DarmA2J4v\nManfVvihwSuVPagKv4y0e/XplRcfpfA5XdBRZa8ulBOeJelvcj5NPwcrK04s0Mxz\n1wOZdy4MALBtc2PCnkkQBbv9sg2d9VIJWFRLvpR6onw+IbnHqR5MTt30ycE2DmR3\nEcX/HasUZLnRldY=\n-----END CERTIFICATE-----"
const KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDLTtqkdysD7G3C\nn29NGSg1D0+HLWQEE7A1fo6QVUAJHEewbokVl+T1hAv2HrtrmpKHP6+m9b2l4B+P\nv7uwp34b/ah8En5nSZha+0+I4Rjs/l7cE9oHba80WFrUzMPl+aTsHyMMNjeje10o\nBfau/piLO6g6niaWdIO/nwXRs3ecGozcF5zPBM/uNGGGcp3hSEAcVWgnuFp9HZEI\nvlSLUJ/NkU9tY/lFYTUGJNgHTe5nkuVVQhnqSFLcdbME/0EzWXahsZwhahrrBno4\nRlGi9Er4bEvlQBCkifH98P2IG7LRPp+uXLY82S1lubnRi9vxnWxDr5/0JR4Dlzgi\n70Wob28PAgMBAAECggEAYtOM4p9u0HRwEkgQAWk2KzyrCumckYLEh+xh/nUCMKuH\niZLhnhZ83H94lQXxUugLTCVADCeuLWCZ1vV7le6FFbQi31TaDvkuTyOUUNQimqk3\nkUExHaVKomZEmOaEX1kPuxuTnM8KErTX3qmvdPcbTasNJplT5pTyqgXx/TKA9Obw\nzUMQWVqo/V4hyS5N6b2g1L/jqyrDnzgcX+iCdvgbkmIuUSOAhGQlxdhYZPwxBoLD\nBBCtrdpbmLHPfdydjBMDfl6lAm1Kv9exa9Luvm2J67fkcCHOw0UURAlkhTWU2nys\nVZi7hu0Pfdv9AykLaZHthN5PvuUPZ/5poCoUM0iBuQKBgQDzIKG/do5ZQJ/Mwt+g\n5iONxNU4L908LT90SAiclAGno+H22wZB6lZYZfloUKLwOCulpzB4qMYhja5jMDhe\nsOpTK31BHVwpFJC16N/6CJYP+WtIrcw0Gc05u2sUxK80UQSNwxCHZn8i3GXnCQ2W\nVW9b36eJwYDg1QRtijQftEQwLQKBgQDWEoGoDExeZK+IRg1yWmmqDcHm1TnIewXJ\n81pjMw0FuTdhWjh7B+njn//+CO9UiI4vwRF2lLhZ3VMFzpagOUlp1EF1hIe6PHbd\nmmFIdd/vbrBEOAmH+rwlGOhosLMGWv4C01V+3qPbDYnVcR5LX/ruSbkvabBpNdLA\nlEgSMtflqwKBgQDDFBbUkqMLOFBAMsjOyHoUoa/XwogIZeH5Qmcug4+EXHnN4dX2\ng7m+eiwRqEnk550V8L1ywzEe8RjQ23sPd3K9QzLgUVeGWsr2OyGj9Mm7jYyop1Mn\nJuDFhv0Xj+1o0+0MdkzH59TxOtjE9T2it3B/zkgWv13SiPlhjzfdjH3+DQKBgQDV\nZxWBpODsqIqj2tHE0YTMVXKa3qz/wkP/Em1kvpuYvQ8MKZhsbXMny3Sylc2gA5Fa\n4ai7AX7VduEwxMU7bGBW85VdxYRYj7YfK6sXRQq78SgemY5G1BmDEdV9p8iP6V2X\nC34LP38w+8oP0PhWQ5Quv6ewMDgAaftyp19BZRX8iQKBgQCU+T3va4uScoA0cQz6\njByiMcWIwm0LCS4J7gZh9K3taVSpJnkvo8yuNtDMbdN+l3bWd7XTMF/bKAE86P1P\nBRn5C7BmPGD3raRhScGIJ9JWSQ+5smjpMbcJUYZn9JeSO5K/aKSyXjk08PMNNqRp\nq63xSw1KVKddlo0lB4NKZdMy6w==\n-----END PRIVATE KEY-----"

const ingest = vi.mocked(ingestServerEmail)

function celld(extra: Record<string, string> = {}) {
  return { LLLL_RUNTIME: 'celld', ...extra } as never
}

function request(url: string, body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', body, headers })
}

async function signedHeaders(raw: Uint8Array, from = 'person@example.net', to = 'support@example.com', timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    'x-llll-email-timestamp': timestamp,
    'x-llll-email-from': from,
    'x-llll-email-to': to,
    'x-llll-email-signature': await signInboundEmail(SECRET, timestamp, from, to, raw),
  }
}

function basic(user: string, password: string) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

function signSns(message: SnsMessage, algorithm: 'RSA-SHA256' | 'RSA-SHA1' = 'RSA-SHA256') {
  const signed = snsStringToSign(message)
  if (!signed) throw new Error('missing string to sign')
  const signer = createSign(algorithm)
  signer.update(signed)
  signer.end()
  return signer.sign(createPrivateKey(KEY)).toString('base64')
}

function snsNotification(content = 'From: person@example.net\r\nTo: support@example.com\r\n\r\nHello\r\n', recipients = ['support@example.com']): SnsMessage {
  return {
    Type: 'Notification',
    MessageId: '11111111-1111-1111-1111-111111111111',
    TopicArn: TOPIC,
    Subject: 'Amazon SES Email Receipt Notification',
    Message: JSON.stringify({
      notificationType: 'Received',
      mail: { source: 'person@example.net' },
      receipt: { recipients },
      content,
    }),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '2',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-example.pem',
  }
}

afterEach(() => {
  ingest.mockReset()
  ingest.mockResolvedValue({ accepted: true })
})

describe('inbound email signature', () => {
  it('matches an independent HMAC over the timestamp, envelope, and raw bytes', async () => {
    const timestamp = '1700000000'
    const from = 'person@example.net'
    const to = 'support@example.com'
    const expected = createHmac('sha256', SECRET)
      .update(Buffer.concat([Buffer.from(`${timestamp}.${from}.${to}.`), Buffer.from(RAW)]))
      .digest('hex')
    expect(await signInboundEmail(SECRET, timestamp, from, to, RAW)).toBe(expected)
    expect(await verifyInboundEmailSignature(SECRET, timestamp, from, to, RAW, expected)).toBe(true)
    expect(await verifyInboundEmailSignature(SECRET, timestamp, from, to, RAW, 'ab'.repeat(32))).toBe(false)
    const tampered = new Uint8Array(RAW)
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1
    expect(await verifyInboundEmailSignature(SECRET, timestamp, from, to, tampered, expected)).toBe(false)
    expect(await verifyInboundEmailSignature(SECRET, timestamp, from, 'other@example.com', RAW, expected)).toBe(false)
  })

  it('rejects timestamps outside the replay window', () => {
    const now = 1_700_000_000_000
    expect(inboundTimestampFresh('1700000000', now)).toBe(true)
    expect(inboundTimestampFresh(String(1_700_000_000 - 300), now)).toBe(true)
    expect(inboundTimestampFresh(String(1_700_000_000 + 300), now)).toBe(true)
    expect(inboundTimestampFresh(String(1_700_000_000 - 301), now)).toBe(false)
    expect(inboundTimestampFresh('not-a-time', now)).toBe(false)
  })

  it('retries only transient webhook statuses', () => {
    expect(inboundWebhookShouldRetry(408)).toBe(true)
    expect(inboundWebhookShouldRetry(429)).toBe(true)
    expect(inboundWebhookShouldRetry(503)).toBe(true)
    expect(inboundWebhookShouldRetry(401)).toBe(false)
    expect(inboundWebhookShouldRetry(404)).toBe(false)
    expect(inboundWebhookShouldRetry(413)).toBe(false)
  })
})

describe('signed inbound webhook', () => {
  it('rejects a missing or short secret and an unsigned body', async () => {
    const headers = await signedHeaders(RAW)
    expect((await acceptSignedInboundEmail(request('https://chat.example.com/api/email/inbound', RAW, headers), celld())).status).toBe(401)
    expect((await acceptSignedInboundEmail(request('https://chat.example.com/api/email/inbound', RAW, headers), celld({ INBOUND_EMAIL_SECRET: 'invalid' }))).status).toBe(401)
    expect((await acceptSignedInboundEmail(request('https://chat.example.com/api/email/inbound', RAW), celld({ INBOUND_EMAIL_SECRET: SECRET }))).status).toBe(401)
    expect(ingest).not.toHaveBeenCalled()
  })

  it('stores a signed raw message and a JSON body whose signature covers the decoded bytes', async () => {
    const headers = await signedHeaders(RAW)
    const accepted = await acceptSignedInboundEmail(
      request('https://chat.example.com/api/email/inbound', RAW, headers),
      celld({ INBOUND_EMAIL_SECRET: SECRET }),
    )
    expect(accepted.status).toBe(202)
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      from: 'person@example.net',
      to: 'support@example.com',
      rawSize: RAW.byteLength,
    }), expect.anything())

    ingest.mockClear()
    const jsonHeaders = await signedHeaders(RAW)
    const encoded = Buffer.from(RAW).toString('base64')
    const json = await acceptSignedInboundEmail(
      request('https://chat.example.com/api/email/inbound', JSON.stringify({ raw: encoded, rawEncoding: 'base64' }), {
        ...jsonHeaders,
        'content-type': 'application/json',
      }),
      celld({ INBOUND_EMAIL_SECRET: SECRET }),
    )
    expect(json.status).toBe(202)
    const envelope = ingest.mock.calls[0]?.[0]
    expect(envelope?.rawSize).toBe(RAW.byteLength)
    const stored = await new Response(envelope?.raw).arrayBuffer()
    expect(new Uint8Array(stored)).toEqual(RAW)
  })

  it('rejects a stale signature, an unknown mailbox, a failed ingest, and an oversized body', async () => {
    const stale = await signedHeaders(RAW, 'person@example.net', 'support@example.com', '1')
    expect((await acceptSignedInboundEmail(request('https://chat.example.com/api/email/inbound', RAW, stale), celld({ INBOUND_EMAIL_SECRET: SECRET }))).status).toBe(401)

    const headers = await signedHeaders(RAW)
    ingest.mockResolvedValueOnce({ accepted: false, reason: 'Unknown L4 mailbox' })
    expect((await acceptSignedInboundEmail(request('https://chat.example.com/api/email/inbound', RAW, headers), celld({ INBOUND_EMAIL_SECRET: SECRET }))).status).toBe(404)

    ingest.mockRejectedValueOnce(new Error('database unavailable'))
    expect((await acceptSignedInboundEmail(request('https://chat.example.com/api/email/inbound', RAW, headers), celld({ INBOUND_EMAIL_SECRET: SECRET }))).status).toBe(500)

    const callsBeforeSize = ingest.mock.calls.length
    const chunk = new Uint8Array(256 * 1024)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAIL_LIMITS.rawBytes) {
          controller.close()
          return
        }
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    const oversized = await acceptSignedInboundEmail(
      new Request('https://chat.example.com/api/email/inbound', { method: 'POST', body: stream, duplex: 'half' }),
      celld({ INBOUND_EMAIL_SECRET: SECRET }),
    )
    expect(oversized.status).toBe(413)
    expect(ingest.mock.calls.length).toBe(callsBeforeSize)
  })
})

describe('provider inbound webhooks', () => {
  it('accepts Postmark basic auth and RawEmail, and rejects a bad password or a missing raw message', async () => {
    const payload = {
      FromFull: { Email: 'person@example.net', Name: 'Person' },
      OriginalRecipient: 'support@example.com',
      RawEmail: new TextDecoder().decode(RAW),
    }
    const accepted = await acceptPostmarkInbound(request('https://chat.example.com/api/email/inbound/postmark', JSON.stringify(payload), {
      authorization: basic('postmark', POSTMARK),
      'content-type': 'application/json',
    }), celld({ POSTMARK_INBOUND_SECRET: POSTMARK }))
    expect(accepted.status).toBe(200)
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ from: 'person@example.net', to: 'support@example.com' }), expect.anything())

    const denied = await acceptPostmarkInbound(request('https://chat.example.com/api/email/inbound/postmark', JSON.stringify(payload), {
      authorization: basic('postmark', 'wrong-password-that-is-long-enough!!'),
    }), celld({ POSTMARK_INBOUND_SECRET: POSTMARK }))
    expect(denied.status).toBe(401)

    const missing = await acceptPostmarkInbound(request('https://chat.example.com/api/email/inbound/postmark', JSON.stringify({ From: 'person@example.net' }), {
      authorization: basic('postmark', POSTMARK),
    }), celld({ POSTMARK_INBOUND_SECRET: POSTMARK }))
    expect(missing.status).toBe(422)
  })

  it('accepts a Mailgun form signature over timestamp and token, and requires body-mime', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const token = 'a'.repeat(50)
    const signature = createHmac('sha256', MAILGUN).update(`${timestamp}${token}`).digest('hex')
    expect(await verifyMailgunSignature(MAILGUN, timestamp, token, signature)).toBe(true)
    const form = new URLSearchParams({
      timestamp,
      token,
      signature,
      recipient: 'support@example.com',
      sender: 'person@example.net',
      'body-mime': new TextDecoder().decode(RAW),
    })
    const accepted = await acceptMailgunInbound(request('https://chat.example.com/api/email/inbound/mailgun', form), celld({ MAILGUN_WEBHOOK_SIGNING_KEY: MAILGUN }))
    expect(accepted.status).toBe(200)
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ from: 'person@example.net', to: 'support@example.com' }), expect.anything())

    form.set('signature', 'ab'.repeat(32))
    expect((await acceptMailgunInbound(request('https://chat.example.com/api/email/inbound/mailgun', form), celld({ MAILGUN_WEBHOOK_SIGNING_KEY: MAILGUN }))).status).toBe(401)

    const noMime = new URLSearchParams({ timestamp, token, signature, recipient: 'support@example.com', sender: 'person@example.net' })
    expect((await acceptMailgunInbound(request('https://chat.example.com/api/email/inbound/mailgun', noMime), celld({ MAILGUN_WEBHOOK_SIGNING_KEY: MAILGUN }))).status).toBe(422)

    const old = String(Math.floor(Date.now() / 1000) - 301)
    const oldSignature = createHmac('sha256', MAILGUN).update(`${old}${token}`).digest('hex')
    const stale = new URLSearchParams({ timestamp: old, token, signature: oldSignature, recipient: 'support@example.com', sender: 'person@example.net', 'body-mime': 'From: a@b.test\r\n\r\nHi' })
    expect((await acceptMailgunInbound(request('https://chat.example.com/api/email/inbound/mailgun', stale), celld({ MAILGUN_WEBHOOK_SIGNING_KEY: MAILGUN }))).status).toBe(401)
  })

  it('verifies an Amazon SNS signature and stores each SES recipient', async () => {
    const message = snsNotification('From: person@example.net\r\nTo: support@example.com\r\nCc: other@example.com\r\n\r\nHello\r\n', ['support@example.com', 'other@example.com'])
    message.Signature = signSns(message)
    const urls: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      urls.push(String(url))
      return new Response(CERT)
    })
    expect(await verifySnsMessage(message, fetcher)).toBe(true)
    ingest.mockResolvedValueOnce({ accepted: true })
    ingest.mockResolvedValueOnce({ accepted: false, reason: 'Unknown L4 mailbox' })
    const accepted = await acceptSesInbound(
      request('https://chat.example.com/api/email/inbound/ses', JSON.stringify(message), { 'content-type': 'application/json' }),
      celld({ SES_SNS_TOPIC_ARN: TOPIC }),
      fetcher,
    )
    expect(accepted.status).toBe(200)
    expect(ingest).toHaveBeenCalledTimes(2)
    expect(ingest.mock.calls.map(call => call[0].to)).toEqual(['support@example.com', 'other@example.com'])

    const wrongTopic = { ...message, TopicArn: 'arn:aws:sns:us-east-1:123456789012:other' }
    const blocked = vi.fn(async () => new Response(CERT))
    expect((await acceptSesInbound(request('https://chat.example.com/api/email/inbound/ses', JSON.stringify(wrongTopic)), celld({ SES_SNS_TOPIC_ARN: TOPIC }), blocked)).status).toBe(401)
    expect(blocked).not.toHaveBeenCalled()

    const evil = { ...message, SigningCertURL: 'https://evil.example/cert.pem', Signature: 'aaaa' }
    const refused = vi.fn(async () => {
      throw new Error('should not fetch')
    })
    expect((await acceptSesInbound(request('https://chat.example.com/api/email/inbound/ses', JSON.stringify(evil)), celld({ SES_SNS_TOPIC_ARN: TOPIC }), refused)).status).toBe(401)
    expect(refused).not.toHaveBeenCalled()
    expect(urls[0]).toBe('https://sns.us-east-1.amazonaws.com/SimpleNotificationService-example.pem')
  })

  it('confirms an SNS subscription only for an amazonaws.com URL', async () => {
    const message: SnsMessage = {
      Type: 'SubscriptionConfirmation',
      MessageId: '22222222-2222-2222-2222-222222222222',
      Token: 'token',
      TopicArn: TOPIC,
      Message: 'You have chosen to subscribe',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=example&Token=token',
      Timestamp: new Date().toISOString(),
      SignatureVersion: '1',
      SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-example.pem',
    }
    message.Signature = signSns(message, 'RSA-SHA1')
    const urls: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      urls.push(String(url))
      return new Response(url.endsWith('.pem') ? CERT : '<ConfirmSubscriptionResponse/>')
    })
    expect((await acceptSesInbound(request('https://chat.example.com/api/email/inbound/ses', JSON.stringify(message)), celld({ SES_SNS_TOPIC_ARN: TOPIC }), fetcher)).status).toBe(200)
    expect(urls).toContain(message.SubscribeURL)

    const hostile = { ...message, SubscribeURL: 'https://evil.example/confirm' }
    hostile.Signature = signSns(hostile, 'RSA-SHA1')
    const seen: string[] = []
    const guard = vi.fn(async (url: string) => {
      seen.push(String(url))
      return new Response(CERT)
    })
    expect((await acceptSesInbound(request('https://chat.example.com/api/email/inbound/ses', JSON.stringify(hostile)), celld({ SES_SNS_TOPIC_ARN: TOPIC }), guard)).status).toBe(400)
    expect(seen.every(url => url.endsWith('.pem'))).toBe(true)
  })
})

describe('inbound provider selection', () => {
  it('reports binding, then bridge, then each provider, and ignores placeholders', () => {
    expect(emailInboundProvider({ LLLL_RUNTIME: 'cloudflare', INBOUND_EMAIL_SECRET: SECRET } as never)).toBe('binding')
    expect(emailInboundProvider(celld({ INBOUND_EMAIL_SECRET: SECRET, POSTMARK_INBOUND_SECRET: POSTMARK }))).toBe('bridge')
    expect(emailInboundProvider(celld({ INBOUND_EMAIL_SECRET: 'invalid', POSTMARK_INBOUND_SECRET: POSTMARK }))).toBe('postmark')
    expect(emailInboundProvider(celld({ MAILGUN_WEBHOOK_SIGNING_KEY: MAILGUN }))).toBe('mailgun')
    expect(emailInboundProvider(celld({ SES_SNS_TOPIC_ARN: TOPIC }))).toBe('ses')
    expect(emailInboundProvider(celld({ SES_SNS_TOPIC_ARN: 'invalid' }))).toBeNull()
    expect(emailInboundProvider(celld())).toBeNull()
  })
})

describe('email bridge', () => {
  it('signs the raw message, retries transient failures, and rejects the rest', async () => {
    const setReject = vi.fn()
    let captured: { url: string, headers: Headers, body: Uint8Array } | null = null
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const payload = init?.body
      const bytes = payload instanceof ArrayBuffer ? new Uint8Array(payload) : new Uint8Array(payload as Uint8Array)
      captured = { url: String(url), headers: new Headers(init?.headers), body: bytes }
      return new Response(null, { status: 202 })
    })
    await forwardInboundEmail({
      from: ' person@example.net ',
      to: 'support@example.com',
      raw: new Blob([RAW]).stream(),
      setReject,
    }, {
      LLLL_INBOUND_URL: 'https://chat.example.com/api/email/inbound',
      INBOUND_EMAIL_SECRET: SECRET,
    }, fetcher)
    expect(setReject).not.toHaveBeenCalled()
    expect(captured?.url).toBe('https://chat.example.com/api/email/inbound')
    expect(await verifyInboundEmailSignature(
      SECRET,
      captured!.headers.get('x-llll-email-timestamp')!,
      'person@example.net',
      'support@example.com',
      captured!.body,
      captured!.headers.get('x-llll-email-signature')!,
    )).toBe(true)

    await expect(forwardInboundEmail({
      from: 'person@example.net',
      to: 'support@example.com',
      raw: new Blob([RAW]).stream(),
      setReject,
    }, {
      LLLL_INBOUND_URL: 'https://chat.example.com/api/email/inbound',
      INBOUND_EMAIL_SECRET: SECRET,
    }, async () => new Response('busy', { status: 503 }))).rejects.toThrow(/503/)

    await forwardInboundEmail({
      from: 'person@example.net',
      to: 'support@example.com',
      raw: new Blob([RAW]).stream(),
      setReject,
    }, {
      LLLL_INBOUND_URL: 'https://chat.example.com/api/email/inbound',
      INBOUND_EMAIL_SECRET: SECRET,
    }, async () => new Response('no', { status: 401 }))
    expect(setReject).toHaveBeenCalled()

    setReject.mockClear()
    const callsBeforeSize = fetcher.mock.calls.length
    await forwardInboundEmail({
      from: 'person@example.net',
      to: 'support@example.com',
      raw: new Blob([RAW]).stream(),
      rawSize: MAIL_LIMITS.rawBytes + 1,
      setReject,
    }, {
      LLLL_INBOUND_URL: 'https://chat.example.com/api/email/inbound',
      INBOUND_EMAIL_SECRET: SECRET,
    }, fetcher)
    expect(setReject).toHaveBeenCalledWith('Message is too large')
    expect(fetcher.mock.calls.length).toBe(callsBeforeSize)

    setReject.mockClear()
    await forwardInboundEmail({
      from: 'person@example.net',
      to: 'support@example.com',
      raw: new Blob([RAW]).stream(),
      setReject,
    }, {
      LLLL_INBOUND_URL: 'https://chat.example.com/api/email/inbound',
      INBOUND_EMAIL_SECRET: 'short',
    }, fetcher)
    expect(setReject).toHaveBeenCalledWith('Inbound email secret is not configured')
  })
})

describe('SNS url checks', () => {
  it('allows only the SNS certificate host and amazonaws.com subscription URLs', () => {
    expect(allowedSnsCertificateUrl('https://sns.us-east-1.amazonaws.com/cert.pem')).toBe('https://sns.us-east-1.amazonaws.com/cert.pem')
    expect(allowedSnsCertificateUrl('http://sns.us-east-1.amazonaws.com/cert.pem')).toBeNull()
    expect(allowedSnsCertificateUrl('https://user:pass@sns.us-east-1.amazonaws.com/cert.pem')).toBeNull()
    expect(allowedSnsCertificateUrl('https://evil.example/cert.pem')).toBeNull()
    expect(allowedSnsCertificateUrl('https://sns.us-east-1.amazonaws.com/cert.txt')).toBeNull()
    expect(allowedSnsSubscribeUrl('https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription')).toContain('ConfirmSubscription')
    expect(allowedSnsSubscribeUrl('https://evil.example/confirm')).toBeNull()
    expect(snsStringToSign({ Type: 'Notification', Message: 'm', MessageId: 'id', Timestamp: 't', TopicArn: 'arn', Subject: 's' })).toContain('Subject\ns\n')
    expect(snsStringToSign({ Type: 'Notification', Message: 'm', MessageId: 'id', Timestamp: 't', TopicArn: 'arn' })).not.toContain('Subject')
  })
})
