import { describe, expect, it } from 'vitest'
import { conversationTitle, inboxAttention, inboxSection, isAgentChat, unreadConversations, unreadTarget, type InboxDTO } from '../../shared/inbox'
import type { ChannelDTO, PublicUser } from '../../shared/types'

const human: PublicUser = { id: 'me', kind: 'human', displayName: 'Owner', avatarR2Key: null }
const agent: PublicUser = { id: 'agent', kind: 'agent', displayName: 'Jev', avatarR2Key: null }
function conversation(id: string, patch: Partial<ChannelDTO> = {}): ChannelDTO {
  return { id, serverId: 'server', name: 'general', topic: '', type: 'text', visibility: 'server', categoryId: null,
    position: 0, liveMeetingId: null, parentId: null, parentMessageId: null, unread: true, unreadCount: 4,
    live: null, createdAt: '2026-10-21T01:00:00Z', ...patch }
}

describe('conversation navigation and Inbox', () => {
  it('separates human, Agent and mixed DMs without moving ordinary channels', () => {
    expect(isAgentChat(conversation('human', { type: 'dm', participants: [human] }))).toBe(false)
    expect(isAgentChat(conversation('agent', { type: 'dm', participants: [human, agent] }))).toBe(true)
    expect(isAgentChat(conversation('mixed', { type: 'dm', participants: [human, agent, { ...human, id: 'other' }] }))).toBe(true)
    expect(isAgentChat(conversation('channel', { participants: [agent] }))).toBe(false)
  })

  it('keeps only unread conversations from this Server, once each, with Server counts', () => {
    const unread = conversation('channel')
    const result = unreadConversations([unread, unread, conversation('read', { unread: false }), conversation('foreign', { serverId: 'other' })], 'server')
    expect(result).toEqual([unread])
    expect(result[0]?.unreadCount).toBe(4)
  })

  it('sorts latest conversations first, including unread Agent messages', () => {
    const older = conversation('older', { createdAt: '2020-01-01', lastMessageAt: '2026-10-22T12:00:00Z' })
    const latest = conversation('latest', { type: 'dm', participants: [agent], lastMessageAt: '2026-10-21T12:00:00Z' })
    expect(unreadConversations([older, latest], 'server').map(channel => channel.id)).toEqual(['older', 'latest'])
  })

  it('reads the Inbox section from the URL and falls back to everything', () => {
    for (const section of ['approvals', 'mentions', 'agents', 'tasks', 'mail', 'chats'] as const) expect(inboxSection(section)).toBe(section)
    expect(inboxSection('unknown')).toBe('all')
    expect(inboxSection(['mentions'])).toBe('all')
  })

  it('counts only decisions and mentions for the rail badge, not standing work', () => {
    const empty: InboxDTO = { approvals: [], mentions: [], runs: [], assigned: [], review: [] }
    expect(inboxAttention(undefined)).toBe(0)
    expect(inboxAttention({ ...empty, runs: [{ id: 'r', status: 'running', createdAt: '', updatedAt: '', agentName: 'Jev', taskTitle: null, conversation: 'general', pullNumber: null }] })).toBe(0)
    expect(inboxAttention({ ...empty, approvals: [{ id: 'a', kind: 'workspace', runId: 'r', agentName: 'Jev', taskTitle: null, operation: 'exec', createdAt: '' }],
      mentions: [{ messageId: 'm', path: '/channels/c', conversation: 'general', author: agent, excerpt: '@Owner look', createdAt: '' }] })).toBe(2)
  })

  it('opens the newest unread thread when only thread replies are new, and says so', () => {
    const thread = (id: string, unreadCount: number, lastMessageAt: string, parentId = 'channel') => ({ id, parentId, title: id, lastMessageAt, opened: true, unread: unreadCount > 0, unreadCount })
    expect(unreadTarget(conversation('channel', { unreadCount: 3 }), [thread('plan', 3, '2026-10-22')])).toEqual({ threadId: 'plan', summary: '3 new replies in “plan”' })
    expect(unreadTarget(conversation('channel', { unreadCount: 3 }), [thread('old', 1, '2026-10-21'), thread('new', 2, '2026-10-22'), thread('other', 5, '2026-10-23', 'elsewhere')]))
      .toEqual({ threadId: 'new', summary: '3 new replies in 2 threads' })
    expect(unreadTarget(conversation('channel', { unreadCount: 4 }), [thread('plan', 1, '2026-10-22')])).toEqual({ summary: '3 new messages, 1 reply in threads' })
    expect(unreadTarget(conversation('channel', { unreadCount: 1 }), [])).toEqual({ summary: '1 new message' })
  })

  it('uses the DM title and identifies the other participant', () => {
    expect(conversationTitle(conversation('dm', { type: 'dm', name: 'dm', participants: [human, agent] }), human.id)).toBe('Jev')
    expect(conversationTitle(conversation('group', { type: 'dm', title: 'Planning' }), human.id)).toBe('Planning')
    expect(conversationTitle(conversation('channel'), human.id)).toBe('general')
  })
})
