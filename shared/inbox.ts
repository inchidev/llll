import { dmTitle } from './dm'
import type { ChannelDTO, PublicUser, TaskPriority, TaskStatus } from './types'

export type InboxMentionDTO = { messageId: string; path: string; conversation: string; author: PublicUser; excerpt: string; createdAt: string }
/** A decision only the initiating Member can make: a review-mode workspace action, or sharing a private result. */
export type InboxApprovalDTO = { id: string; kind: 'workspace' | 'publication'; runId: string; agentName: string; taskTitle: string | null; operation: string; createdAt: string }
export type InboxRunDTO = { id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; createdAt: string; updatedAt: string; agentName: string; taskTitle: string | null; conversation: string; pullNumber: number | null }
export type InboxTaskDTO = { id: string; number: number; title: string; status: TaskStatus; priority: TaskPriority; dueAt: string | null; boardName: string }
export type InboxDTO = { approvals: InboxApprovalDTO[]; mentions: InboxMentionDTO[]; runs: InboxRunDTO[]; assigned: InboxTaskDTO[]; review: InboxTaskDTO[] }

export const INBOX_SECTIONS = ['all', 'approvals', 'mentions', 'agents', 'tasks', 'mail', 'chats'] as const
export type InboxSection = typeof INBOX_SECTIONS[number]
export function inboxSection(value: unknown): InboxSection {
  return (INBOX_SECTIONS as readonly unknown[]).includes(value) ? value as InboxSection : 'all'
}

/** The rail badge counts what is new and needs a reply or a decision; standing work is listed, not counted. */
export function inboxAttention(inbox: InboxDTO | undefined): number {
  return inbox ? inbox.approvals.length + inbox.mentions.length : 0
}

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
