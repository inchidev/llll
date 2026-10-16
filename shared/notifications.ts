export const notificationKinds = ['mention', 'dm_message', 'huddle_started'] as const

export type NotificationKind = typeof notificationKinds[number]

export type PushNotificationPayload = {
  title: string
  body: string
  tag: string
  url: string
  icon: string
  badge: string
}

export type BrowserPushSubscription = {
  endpoint: string
  expirationTime: number | null
  keys: {
    p256dh: string
    auth: string
  }
}

export type PushConfig = {
  configured: boolean
  publicKey: string | null
}

export type PushDeliveryDisposition = 'delivered' | 'expired' | 'retry' | 'failed'

export function pushDeliveryDisposition(status: number): PushDeliveryDisposition {
  if (status >= 200 && status < 300) return 'delivered'
  if (status === 404 || status === 410) return 'expired'
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry'
  return 'failed'
}

export function notificationPreview(content: string, attachmentCount: number): string {
  const normalized = content
    .replace(/<@[0-9a-f-]+>/giu, '@member')
    .replace(/\s+/gu, ' ')
    .trim()
  if (normalized) return normalized.length > 140 ? `${normalized.slice(0, 139)}…` : normalized
  if (attachmentCount === 1) return 'Sent an attachment'
  if (attachmentCount > 1) return `Sent ${attachmentCount} attachments`
  return 'New message'
}

export function isSafePushEndpoint(value: string): boolean {
  if (value.length < 12 || value.length > 4096) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
    const host = url.hostname.toLowerCase()
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
    if (host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return false
    return true
  }
  catch {
    return false
  }
}

export function isBase64UrlKey(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/u.test(value)
}

export function pushRetryDelayMs(attempt: number): number {
  return Math.min(60 * 60 * 1000, 15_000 * 2 ** Math.max(0, attempt - 1))
}
