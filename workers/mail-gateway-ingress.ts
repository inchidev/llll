import type { L4Env } from './env'
import { ingestWorkspaceEmail } from './mail-ingress'

const encoder = new TextEncoder()

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(value))
}

export async function secureTokenEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)])
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (left: BufferSource, right: BufferSource) => boolean }
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(leftDigest, rightDigest)
  const leftBytes = new Uint8Array(leftDigest)
  const rightBytes = new Uint8Array(rightDigest)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index]! ^ rightBytes[index]!
  return difference === 0
}

function bearerToken(request: Request): string {
  const value = request.headers.get('Authorization') || ''
  return value.startsWith('Bearer ') ? value.slice(7) : ''
}

export async function receiveMailGatewayRequest(request: Request, env: L4Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!env.MAIL_GATEWAY_TOKEN || !await secureTokenEqual(bearerToken(request), env.MAIL_GATEWAY_TOKEN)) {
    return new Response('Unauthorized', { status: 401 })
  }
  const from = request.headers.get('X-L4-Mail-From')?.trim()
  const to = request.headers.get('X-L4-Mail-To')?.trim()
  if (!from || !to || !request.body) return new Response('Invalid mail envelope', { status: 400 })
  const size = Number(request.headers.get('Content-Length'))
  const result = await ingestWorkspaceEmail({ from, to, raw: request.body, rawSize: Number.isFinite(size) && size > 0 ? size : undefined }, env)
  if (!result.accepted) return new Response(result.reason, { status: 404 })
  return new Response(null, { status: 202 })
}
