/** Notification kinds the Telegram relay turns into a fixed, content-free message. */
export const TELEGRAM_RELAY_KINDS = ['mention', 'dm_message', 'live_started', 'mail'] as const
export type TelegramRelayKind = (typeof TELEGRAM_RELAY_KINDS)[number]

/** A Telegram delivery target's endpoint key; real Web Push endpoints are always HTTPS. */
export const TELEGRAM_ENDPOINT_PREFIX = 'telegram:'
