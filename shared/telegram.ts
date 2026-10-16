import { z } from 'zod'

const telegramUser = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), first_name: z.string().min(1).max(100), last_name: z.string().max(100).optional(), photo_url: z.string().url().max(2048).optional() })

/** Telegram's raw, signed launch data. Never accept initDataUnsafe. */
export async function verifyMiniAppData(raw: string, botToken: string, now = Date.now()) {
  const params = new URLSearchParams(raw)
  const seen = new Set<string>()
  for (const [key] of params) {
    if (seen.has(key)) throw new Error('Duplicate Mini App field')
    seen.add(key)
  }
  const hash = params.get('hash') || ''
  const date = Number(params.get('auth_date'))
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(date) || date > now / 1000 + 30 || now / 1000 - date > 300) throw new Error('Expired or invalid Mini App data')
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
