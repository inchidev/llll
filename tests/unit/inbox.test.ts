import { describe, expect, it } from 'vitest'
import { conversationTitle, inboxFilter, isAgentChat, matchesInboxFilter, unreadConversations } from '../../shared/inbox'
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
    const older = conversation('older')
    const latest = conversation('latest', { type: 'dm', participants: [agent], lastMessageAt: '2026-10-21T12:00:00Z' })
    expect(unreadConversations([older, latest], 'server').map(channel => channel.id)).toEqual(['latest', 'older'])
  })

  it('partitions unread conversations by URL filter without mixing human and Agent chats', () => {
    const items = [conversation('channel'), conversation('human', { type: 'dm', participants: [human] }), conversation('agent', { type: 'dm', participants: [agent] })]
    for (const [filter, ids] of [['all', ['channel', 'human', 'agent']], ['channels', ['channel']], ['direct', ['human']], ['agents', ['agent']]] as const) {
      expect(items.filter(item => matchesInboxFilter(item, filter)).map(item => item.id)).toEqual(ids)
      expect(inboxFilter(filter)).toBe(filter)
    }
    expect(inboxFilter('unknown')).toBe('all')
    expect(inboxFilter(['agents', 'direct'])).toBe('all')
  })

  it('uses the DM title and identifies the other participant', () => {
    expect(conversationTitle(conversation('dm', { type: 'dm', name: 'dm', participants: [human, agent] }), human.id)).toBe('Jev')
    expect(conversationTitle(conversation('group', { type: 'dm', title: 'Planning' }), human.id)).toBe('Planning')
    expect(conversationTitle(conversation('channel'), human.id)).toBe('general')
  })
})
