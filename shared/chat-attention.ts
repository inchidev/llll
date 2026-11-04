export const CHAT_NOTIFICATION_LEVELS = ['default', 'all', 'mentions', 'muted'] as const
export type ChatNotificationLevel = typeof CHAT_NOTIFICATION_LEVELS[number]

export type ChatAttention = {
  following: boolean
  notifications: ChatNotificationLevel
  readGeneration: number
}

export type FollowedThread = {
  id: string
  parentId: string
  title: string
  conversation: string
  path: string
  excerpt: string
  lastMessageAt: string
  unreadCount: number
}

export function chatNotificationAllowed(level: ChatNotificationLevel, input: { dm: boolean; thread: boolean; following: boolean; mentioned: boolean }): boolean {
  if (level === 'muted') return false
  if (input.mentioned) return true
  if (input.dm && (level === 'default' || level === 'all')) return true
  if (input.thread) return input.following && (level === 'default' || level === 'all')
  return level === 'all' || (level === 'default' && input.dm)
}
