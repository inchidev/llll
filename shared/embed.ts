import { z } from 'zod'

export const EMBED_VERSION = 1
export const uuidSchema = z.string().uuid()
export const embedCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), serverId: uuidSchema, path: z.string().max(2000).default('/') }),
  z.object({ type: z.literal('theme'), theme: z.enum(['light', 'dark', 'system']) }),
  z.object({ type: z.literal('telegram'), initData: z.string().min(1).max(16000) }),
])
export const embedEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), version: z.literal(EMBED_VERSION), name: z.string().max(100) }),
  z.object({ type: z.literal('session'), authenticated: z.boolean() }),
  z.object({ type: z.literal('servers'), servers: z.array(z.object({ id: uuidSchema, name: z.string().max(100), iconUrl: z.string().max(2048).nullable().optional(), updatedAt: z.string().datetime().optional(), unread: z.number().int().min(0).default(0) })).max(500) }),
  z.object({ type: z.literal('navigate'), serverId: uuidSchema, path: z.string().max(2000) }),
  z.object({ type: z.literal('call'), active: z.boolean() }),
  z.object({ type: z.literal('open-rejected'), serverId: uuidSchema, currentServerId: uuidSchema.optional(), path: z.string().max(2000).optional(), reason: z.enum(['call-active', 'unavailable']) }),
])

export function safeEmbedPath(path: string) {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && ![...path].some(char => char.charCodeAt(0) < 32)
    && !/^\/(?:api|ws|connections|embed)(?:\/|\?|$)/.test(path)
}

export function embedOrigins(value = '') {
  return [...new Set(['https://llll.gg', ...value.split(',').map(v => v.trim()).filter(Boolean)])].filter(value => {
    try { const url = new URL(value); return url.origin === value && (url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname)) }
    catch { return false }
  })
}
