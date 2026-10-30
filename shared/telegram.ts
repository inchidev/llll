import { z } from 'zod'

const telegramUser = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), first_name: z.string().min(1).max(100), last_name: z.string().max(100).optional(), photo_url: z.string().url().max(2048).optional() })

/** Telegram's raw, signed launch data. Never accept initDataUnsafe. */
export async function verifyMiniAppData(raw: string, botToken: string, now = Date.now(), maxAgeSeconds = 300) {
  const params = new URLSearchParams(raw)
  const seen = new Set<string>()
  for (const [key] of params) {
    if (seen.has(key)) throw new Error('Duplicate Mini App field')
    seen.add(key)
  }
  const hash = params.get('hash') || ''
  const date = Number(params.get('auth_date'))
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(date) || date > now / 1000 + 30 || now / 1000 - date > maxAgeSeconds) throw new Error('Expired or invalid Mini App data')
  params.delete('hash')
  const encoder = new TextEncoder()
  const secretKey = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken))
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const signature = Uint8Array.from(hash.match(/../g)!, value => Number.parseInt(value, 16))
  const data = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => `${name}=${value}`).join('\n')
  if (!await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data))) throw new Error('Invalid Mini App signature')
  return telegramUser.parse(JSON.parse(params.get('user') || 'null'))
}

/** Third-party servers verify Telegram itself; they never receive the bot secret. */
export async function verifyTelegramPublicData(raw: string, botId: string, now = Date.now(), publicKey = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d') {
  if (!/^[1-9]\d{0,15}$/.test(botId)) throw new Error('Invalid Telegram bot ID')
  const params = new URLSearchParams(raw)
  const seen = new Set<string>()
  for (const [key] of params) { if (seen.has(key)) throw new Error('Duplicate Mini App field'); seen.add(key) }
  const date = Number(params.get('auth_date'))
  const signature = params.get('signature') || ''
  if (!Number.isSafeInteger(date) || date > now / 1000 + 30 || now / 1000 - date > 300 || !/^[a-zA-Z0-9_-]{86}={0,2}$/.test(signature)) throw new Error('Expired or invalid Telegram proof')
  params.delete('hash'); params.delete('signature')
  const data = `${botId}:WebAppData\n` + [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => `${name}=${value}`).join('\n')
  const bytes = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/').padEnd(88, '=')), char => char.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(publicKey.match(/../g)!, value => Number.parseInt(value, 16)), { name: 'Ed25519' }, false, ['verify'])
  if (!await crypto.subtle.verify('Ed25519', key, bytes, new TextEncoder().encode(data))) throw new Error('Invalid Telegram signature')
  return telegramUser.parse(JSON.parse(params.get('user') || 'null'))
}
