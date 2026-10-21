import { dmTitle } from './dm'
import type { ChannelDTO } from './types'

/** Mixed human/Agent conversations belong with Agent chats, exactly once. */
export function isAgentChat(channel: ChannelDTO): boolean {
  return channel.type === 'dm' && Boolean(channel.participants?.some(member => member.kind === 'agent'))
}

export function conversationTitle(channel: ChannelDTO, userId: string): string {
  return channel.type === 'dm'
    ? channel.title || dmTitle(channel.name, channel.participants ?? [], userId)
    : channel.name
}

/** Counts come from the Server, including unread replies in a channel's threads. */
export function unreadConversations(channels: ChannelDTO[], serverId: string): ChannelDTO[] {
  return [...new Map(channels.filter(channel => channel.serverId === serverId && channel.unread).map(channel => [channel.id, channel])).values()]
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt) || a.id.localeCompare(b.id))
}
