const encoder = new TextEncoder()

const SNS_CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/i

export type SnsMessage = {
  Type?: string
  MessageId?: string
  TopicArn?: string
  Subject?: string
  Message?: string
  Timestamp?: string
  SignatureVersion?: string
  Signature?: string
  SigningCertURL?: string
  SubscribeURL?: string
  Token?: string
}

/** HTTPS SubscribeURL on amazonaws.com. Other hosts are not requested. */
export function allowedSnsSubscribeUrl(value: string): string | null {
  return allowedAwsHttpsUrl(value, host => host === 'amazonaws.com' || host.endsWith('.amazonaws.com'))
}

/** Only the Amazon SNS certificate host. Other URLs are not fetched. */
export function allowedSnsCertificateUrl(value: string): string | null {
  return allowedAwsHttpsUrl(value, host => SNS_CERT_HOST.test(host), url => url.pathname.endsWith('.pem'))
}

function allowedAwsHttpsUrl(value: string, hostOk: (host: string) => boolean, pathOk: (url: URL) => boolean = () => true): string | null {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if (url.port && url.port !== '443') return null
  if (!hostOk(url.hostname.toLowerCase())) return null
  if (!pathOk(url)) return null
  return url.toString()
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function pemToDer(pem: string): Uint8Array | null {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '')
  if (!body || body.length > 20_000) return null
  try {
    const binary = atob(body)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  catch {
    return null
  }
}

function readDer(bytes: Uint8Array, offset: number): { start: number, next: number, content: number } | null {
  if (offset >= bytes.length) return null
  const start = offset
  let length = bytes[offset + 1]
  let content = offset + 2
  if (length === undefined) return null
  if (length & 0x80) {
    const count = length & 0x7f
    if (count === 0 || count > 3) return null
    length = 0
    for (let index = 0; index < count; index += 1) {
      const byte = bytes[content + index]
      if (byte === undefined) return null
      length = (length << 8) | byte
    }
    content += count
  }
  const next = content + length
  if (next > bytes.length) return null
  return { start, next, content }
}

/** Subject public key info from an X.509 certificate, for WebCrypto import. */
export function certificatePublicKey(pem: string): Uint8Array | null {
  const der = pemToDer(pem)
  if (!der) return null
  const certificate = readDer(der, 0)
  if (!certificate || der[certificate.start] !== 0x30) return null
  const body = readDer(der, certificate.content)
  if (!body || der[body.start] !== 0x30) return null
  let cursor = body.content
  if (der[cursor] === 0xa0) {
    const version = readDer(der, cursor)
    if (!version) return null
    cursor = version.next
  }
  for (let index = 0; index < 5; index += 1) {
    const field = readDer(der, cursor)
    if (!field) return null
    cursor = field.next
  }
  const key = readDer(der, cursor)
  if (!key || der[key.start] !== 0x30) return null
  return der.slice(key.start, key.next)
}

/**
 * Canonical string Amazon SNS signs. Notification includes Subject only when
 * the field is present. Confirmation messages include SubscribeURL and Token.
 */
export function snsStringToSign(message: SnsMessage): string | null {
  const type = message.Type
  if (type !== 'Notification' && type !== 'SubscriptionConfirmation' && type !== 'UnsubscribeConfirmation') return null
  const fields = type === 'Notification'
    ? ['Message', 'MessageId', ...(typeof message.Subject === 'string' ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
  const lines: string[] = []
  for (const field of fields) {
    const value = message[field as keyof SnsMessage]
    if (typeof value !== 'string') return null
    lines.push(`${field}\n${value}\n`)
  }
  return lines.join('')
}

async function importCertificateKey(pem: string, hash: 'SHA-1' | 'SHA-256'): Promise<CryptoKey | null> {
  const spki = certificatePublicKey(pem)
  if (!spki) return null
  try {
    return await crypto.subtle.importKey('spki', copyBuffer(spki), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify'])
  }
  catch {
    return null
  }
}

export async function verifySnsMessage(message: SnsMessage, fetcher: typeof fetch = fetch): Promise<boolean> {
  const certUrl = message.SigningCertURL ? allowedSnsCertificateUrl(message.SigningCertURL) : null
  const signature = message.Signature
  const signed = snsStringToSign(message)
  if (!certUrl || !signature || !signed) return false
  const hash = message.SignatureVersion === '1' ? 'SHA-1' : message.SignatureVersion === '2' ? 'SHA-256' : null
  if (!hash) return false
  let response: Response
  try {
    response = await fetcher(certUrl, { redirect: 'manual' })
  }
  catch {
    return false
  }
  if (!response.ok) return false
  const pem = await response.text()
  const key = await importCertificateKey(pem, hash)
  if (!key) return false
  let signatureBytes: Uint8Array
  try {
    const binary = atob(signature)
    signatureBytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) signatureBytes[index] = binary.charCodeAt(index)
  }
  catch {
    return false
  }
  return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, copyBuffer(signatureBytes), encoder.encode(signed))
}
